# clic-whatsapp-sender

Manda los avisos internos de Clicnet a los grupos de WhatsApp de cada sede.

Es un servicio aparte por una razón concreta: **la API oficial de Meta no permite
mandar mensajes a grupos**. Para postear en un grupo hay que usar WhatsApp Web, y
eso significa un Chromium corriendo con una sesión vinculada — algo que no puede
vivir adentro del build de Next.js de Clicnet.

## Cómo encaja

```
┌──────────────┐   encola Notificacion    ┌──────────────┐
│   Clicnet    │   canal = WHATSAPP        │  Postgres    │
│  (Next.js)   │ ────────────────────────► │              │
└──────────────┘                           └──────┬───────┘
                                                  │
      GET  /api/whatsapp-sender/cola              │
      POST /api/whatsapp-sender/resultado         │
      POST /api/whatsapp-sender/heartbeat         │
      POST /api/whatsapp-sender/qr                │
                    ▲                             │
                    │                             │
             ┌──────┴───────────────────────┐     │
             │  clic-whatsapp-sender        │ ◄───┘
             │  (este repo, Railway)        │
             │  whatsapp-web.js + Chromium  │
             └──────────────┬───────────────┘
                            │ sendMessage
                            ▼
                   Grupos de WhatsApp
```

**Clicnet es el dueño de la cola.** Acá no se guarda nada: si el servicio se cae,
los mensajes quedan `PENDIENTE` y salen cuando vuelve. Por eso el sender
*pregunta* (polling) en vez de que Clicnet le pegue.

## Variables de entorno

| Variable | Obligatoria | Default | Qué es |
|---|---|---|---|
| `CLICNET_URL` | sí | — | URL de Clicnet, sin barra final |
| `SENDER_TOKEN` | sí | — | Mismo valor que `WHATSAPP_SENDER_TOKEN` en Clicnet |
| `DATA_PATH` | no | `/data` | Dónde vive la sesión. **Tiene que ser el volumen** |
| `POLL_INTERVAL_MS` | no | `10000` | Cada cuánto pide la cola |
| `HEARTBEAT_INTERVAL_MS` | no | `60000` | Cada cuánto reporta que está vivo |
| `DELAY_ENVIO_MS` | no | `4000` | Espera entre mensajes. **No bajar sin pensarlo** |
| `RECICLAR_CADA_MS` | no | `86400000` | Cada cuánto sale a propósito para arrancar limpio |
| `CHROMIUM_HEAP_MB` | no | `512` | Techo del heap de V8 en el renderer |
| `CHROMIUM_CACHE_MB` | no | `100` | Techo de la caché de disco de Chromium |
| `PORT` | no | `3000` | Healthcheck en `/health` |

## La memoria de Chromium

Este servicio manda un par de mensajes por día y, sin embargo, llegó a ser **el
más caro de toda la cuenta de Railway**: promediaba 2,3 GB de memoria contra 0,4
de Clicnet, o sea más que todos los demás servicios juntos ($23 de $42 por mes,
a $10 por GB-mes).

No es que Chromium sea pesado, es que **pierde memoria**: arrancaba en ~1,2 GB y
trepaba hasta ~2,9 GB en unos días, hasta que algo lo reiniciaba y volvía a
empezar. Railway factura el promedio por minuto, así que esa pendiente es plata.
La fuga está adentro de WhatsApp Web y no se arregla desde acá; lo que sí se
puede es no dejarla correr:

- **Reciclado cada 24h** (`RECICLAR_CADA_MS`). El proceso sale con código 0 y
  Railway levanta uno nuevo. Sólo lo hace con la cola vacía, así que no puede
  cortar un envío por la mitad.
- **Techo de heap y un solo renderer.** Sin `--max-old-space-size`, V8 crece
  hasta donde haya RAM — y el límite del servicio es el del plan, 24 GB.
- **Caché de disco acotada y limpiada al arrancar.** El perfil vive en el
  volumen: sin tope la caché crecía para siempre (llegó a 3,8 GB, con la sesión
  pesando unos pocos MB). Lo borra `prepararPerfil()` en `src/perfil.js`, con
  una **lista blanca** de directorios — el perfil de Chromium *es* el directorio
  de la sesión, así que borrar de más significa perder la vinculación y tener
  que ir con el celular a escanear el QR de nuevo.

Conviene además tener un **límite de memoria de ~1,5 GB** puesto en el servicio
desde el dashboard de Railway. No arregla nada, pero es lo que evita que esto
vuelva a aparecer en una factura sin que nadie se entere.

## Deploy en Railway

Ya está deployado en el proyecto **Clic Net**, entorno `production`, como el
servicio **WhatsApp Sender** (al lado de Clicnet y su Postgres).

Cuatro cosas que no son opcionales:

1. **Volumen montado en `/data`.** Sin volumen, cada deploy pierde la sesión y
   pide QR de nuevo. El Dockerfile **no** puede declararlo: Railway rechaza el
   build si encuentra un `VOLUME` (`use Railway Volumes`). Se crea del lado de
   Railway — por CLI es `railway volume -p <proj> -e <env> -s <svc> add -m /data`.
2. **Una sola réplica.** La sesión de whatsapp-web.js es un lock de archivo: dos
   instancias sobre el mismo volumen se pisan y desloguean el número.
3. **`SENDER_TOKEN` igual en los dos lados.** Generalo con
   `openssl rand -base64 48` y cargalo como `WHATSAPP_SENDER_TOKEN` en Clicnet.
4. **`restartPolicyType: ALWAYS`** en el `railway.json`. La política por defecto
   de Railway es *On Failure*, **limitada a 10 reinicios**, y este servicio está
   diseñado para salir y que lo levanten: sale con 1 cada vez que WhatsApp se
   desconecta y con 0 en cada reciclado. Con *On Failure* se quedaba sin
   reinicios y el sender moría hasta que alguien redeployara a mano; además, el
   reciclado con código 0 directamente no lo habría levantado. Un error de
   config en un deploy nuevo sigue estando cubierto por el healthcheck, que
   marca el deploy como fallido y deja corriendo el anterior.

## Vincular el número

1. Deployar. El servicio arranca sin sesión y publica el QR en Clicnet.
2. Entrar a **Sedes → Avisos por WhatsApp** en Clicnet: ahí aparece el QR.
3. Escanearlo desde el celular del número de Clic
   (WhatsApp → Dispositivos vinculados → Vincular un dispositivo).
4. Sumar ese número a los grupos de cada sede.
5. Esperar un latido (hasta 60s) y elegir cada grupo en la misma pantalla.

Usar un **número dedicado de Clic**, no el de una recepción ni uno personal:
whatsapp-web.js es una integración no oficial y WhatsApp puede banear el número
que la use.

## Correr en local

```bash
npm install
CLICNET_URL=http://localhost:3000 \
SENDER_TOKEN=<el mismo que en el .env de Clicnet> \
DATA_PATH=./.data \
npm start
```

En local usa el Chromium que encuentre en `CHROME_BIN`; si no, hay que instalar
uno o correr el contenedor.
