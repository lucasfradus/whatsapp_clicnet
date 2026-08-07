# Chromium propio del sistema: el que baja Puppeteer no corre en Alpine ni en
# la imagen slim, y bajarlo en cada build son 150MB al pedo.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CHROME_BIN=/usr/bin/chromium \
    NODE_ENV=production \
    DATA_PATH=/data

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

# Nada de `VOLUME /data` acá: Railway rechaza el build si el Dockerfile declara
# volúmenes ("use Railway Volumes"). El volumen se monta del lado de Railway, y
# es obligatorio: sin él, cada deploy pierde la sesión y pide QR de nuevo.

CMD ["node", "src/index.js"]
