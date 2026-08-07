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

# Montar acá el volumen de Railway. Sin volumen, cada deploy pide QR de nuevo.
VOLUME ["/data"]

CMD ["node", "src/index.js"]
