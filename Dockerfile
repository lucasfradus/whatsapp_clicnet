# Sin navegador. Baileys habla el protocolo de WhatsApp por WebSocket, así que
# esto es un servicio Node y nada más.
#
# Antes acá se instalaba Chromium por apt para whatsapp-web.js: 666 MB de imagen
# y un proceso que perdía memoria a ~0,38 GB por día. Si alguien vuelve a
# necesitar un navegador acá, conviene releer por qué se fue.
FROM node:20-slim

ENV NODE_ENV=production \
    DATA_PATH=/data

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src

# Nada de `VOLUME /data` acá: Railway rechaza el build si el Dockerfile declara
# volúmenes ("use Railway Volumes"). El volumen se monta del lado de Railway, y
# es obligatorio: sin él, cada deploy pierde la sesión y pide QR de nuevo.

CMD ["node", "src/index.js"]
