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
| `PORT` | no | `3000` | Healthcheck en `/health` |

## Deploy en Railway

Tres cosas que no son opcionales:

1. **Volumen montado en `/data`.** Sin volumen, cada deploy pierde la sesión y
   pide QR de nuevo.
2. **Una sola réplica.** La sesión de whatsapp-web.js es un lock de archivo: dos
   instancias sobre el mismo volumen se pisan y desloguean el número.
3. **`SENDER_TOKEN` igual en los dos lados.** Generalo con
   `openssl rand -base64 48` y cargalo como `WHATSAPP_SENDER_TOKEN` en Clicnet.

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
