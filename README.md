# clic-whatsapp-sender

Manda los avisos internos de Clicnet a los grupos de WhatsApp de cada sede.

Es un servicio aparte por una razón concreta: **la API oficial de Meta no permite
mandar mensajes a grupos**. Para postear en un grupo hay que usar WhatsApp Web, y
eso significa hablar el protocolo de WhatsApp Web con una sesión vinculada —
algo que no puede vivir adentro del build de Next.js de Clicnet.

Usa **[Baileys](https://github.com/WhiskeySockets/Baileys)**, que habla ese
protocolo directo por WebSocket. **No hay navegador.**

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
             │  Baileys (WebSocket)         │
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
| `DATA_PATH` | no | `/data` | Dónde vive el auth state. **Tiene que ser el volumen** |
| `POLL_INTERVAL_MS` | no | `10000` | Cada cuánto pide la cola |
| `HEARTBEAT_INTERVAL_MS` | no | `60000` | Cada cuánto reporta que está vivo |
| `DELAY_ENVIO_MS` | no | `4000` | Espera entre mensajes. **No bajar sin pensarlo** |
| `RECICLAR_CADA_MS` | no | `604800000` | Cada cuánto sale a propósito. Seguro, no arreglo — ver abajo |
| `PORT` | no | `3000` | Healthcheck en `/health` |

## Por qué no hay un navegador acá

Hasta septiembre de 2026 esto usaba **whatsapp-web.js**, que maneja un Chromium
headless. Ese Chromium era el problema: este servicio manda un par de mensajes
por día y era **el más caro de toda la cuenta de Railway** — promediaba 2,3 GB
de memoria contra 0,4 de Clicnet, más que todos los demás servicios juntos ($23
de $42 al mes, a $10 por GB-mes).

No es que Chromium sea pesado, es que **perdía memoria**: ~0,38 GB por día,
sobre un piso de 836 MB. Los flags de Chromium bajaron el piso un 30% pero no
tocaron la pendiente, y reciclar el proceso más seguido tenía rendimientos
decrecientes (de 24h a 6h eran $1,40 al mes). El costo lo dominaba el piso, y
ese piso se pagaba por el solo hecho de tener un navegador prendido.

Baileys lo saca del medio. Medido:

| | whatsapp-web.js | Baileys |
|---|---:|---:|
| Memoria | 836 MB de piso | ~100 MB |
| Imagen del deploy | 666 MB | ~150 MB |
| Volumen | 3,3 GB | unos JSON de pocos KB |
| `node_modules` | 108 MB | 46 MB |

Y de paso se fueron tres cosas que no eran plata:

- **El volumen que crecía sin techo**, y con él toda la familia de bugs del
  `SingletonLock` — no hay perfil de navegador que se corrompa.
- **`getChats()`**, roto hacía meses, que dejaba el selector de destinos
  mostrando JIDs crudos. Baileys tiene `groupFetchAllParticipating()`.
- **El `exit(1)` en cada desconexión.** Sin Chromium que quede colgado,
  reconectar en caliente es lo correcto — y era ese `exit(1)` lo que gastaba el
  presupuesto de reinicios de Railway.

### Dos cosas que no son obvias

**`cachedGroupMetadata` no es una optimización.** Al mandar a un grupo, Baileys
necesita la lista de participantes para cifrarle a cada uno; sin caché la pide a
WhatsApp en **cada** envío, y eso dispara rate limits y baneos. Acá *todos* los
mensajes van a grupos, así que sacarla sería peor que no haber migrado.

**En `loggedOut` hay que borrar el auth state.** Si no, cada reintento falla
igual y con `restartPolicyType: ALWAYS` quedás en un loop de reinicios infinito.
Borrándolo, el reconnect emite un QR nuevo y alguien lo escanea desde Clicnet.

### La versión está fijada exacta

`baileys` está pineado en **6.7.24**, sin `^`. El dist-tag `latest` del paquete
apunta a `7.0.0-rc14` (un *release candidate*) y la última estable está
etiquetada `legacy`, así que un `npm install` descuidado se trae un RC. En algún
momento hay que migrar a la v7 — no dejar que pase solo.

## Deploy en Railway

Ya está deployado en el proyecto **Clic Net**, entorno `production`, como el
servicio **WhatsApp Sender** (al lado de Clicnet y su Postgres).

Cuatro cosas que no son opcionales:

1. **Volumen montado en `/data`.** Sin volumen, cada deploy pierde la sesión y
   pide QR de nuevo. El Dockerfile **no** puede declararlo: Railway rechaza el
   build si encuentra un `VOLUME` (`use Railway Volumes`). Se crea del lado de
   Railway — por CLI es `railway volume -p <proj> -e <env> -s <svc> add -m /data`.
2. **Una sola réplica.** Dos instancias con el mismo auth state se pisan las
   claves de sesión y terminan desvinculando el número.
3. **`SENDER_TOKEN` igual en los dos lados.** Generalo con
   `openssl rand -base64 48` y cargalo como `WHATSAPP_SENDER_TOKEN` en Clicnet.
4. **`restartPolicyType: ALWAYS`** en el `railway.json`. La política por defecto
   de Railway es *On Failure*, **limitada a 10 reinicios**, y este servicio está
   diseñado para salir y que lo levanten: sale con 0 en cada reciclado y con 1
   si no logra reconectar. Con *On Failure* el reciclado con código 0
   directamente no lo levantaría, y el cupo de 10 reinicios se agotaba. Un error de
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
Baileys es una integración no oficial y WhatsApp puede banear el número que la
use. (whatsapp-web.js también lo era: en esto no cambió nada.)

## Correr en local

```bash
npm install
CLICNET_URL=http://localhost:3000 \
SENDER_TOKEN=<el mismo que en el .env de Clicnet> \
DATA_PATH=./.data \
npm start
```

No hace falta instalar nada más: no hay navegador. El QR sale por los logs y se
publica en Clicnet igual que en producción.
