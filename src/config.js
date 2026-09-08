/**
 * Toda la config viene por variables de entorno (Railway).
 * Si falta algo obligatorio, el servicio no arranca: preferimos que Railway
 * muestre el crash a que quede corriendo sin mandar nada y nadie se entere.
 */

function requerido(nombre) {
  const valor = process.env[nombre]
  if (!valor) {
    console.error(`[config] Falta la variable ${nombre}`)
    process.exit(1)
  }
  return valor
}

function numero(nombre, porDefecto) {
  const valor = Number(process.env[nombre])
  return Number.isFinite(valor) && valor > 0 ? valor : porDefecto
}

export const config = {
  /** URL de Clicnet, sin barra final. Ej: https://clicnet-production.up.railway.app */
  clicnetUrl: requerido("CLICNET_URL").replace(/\/$/, ""),
  /** Mismo valor que WHATSAPP_SENDER_TOKEN en Clicnet. */
  token: requerido("SENDER_TOKEN"),

  /** Cada cuánto pedimos la cola. */
  pollIntervalMs: numero("POLL_INTERVAL_MS", 10_000),
  /** Cada cuánto reportamos que estamos vivos. */
  heartbeatIntervalMs: numero("HEARTBEAT_INTERVAL_MS", 60_000),

  /**
   * Espera entre mensaje y mensaje. No bajar de 3s sin pensarlo: mandar en
   * ráfaga es la forma más rápida de que WhatsApp banee el número.
   */
  delayEnvioMs: numero("DELAY_ENVIO_MS", 4_000),

  /**
   * Cada cuánto salimos a propósito para que Railway levante un proceso nuevo.
   *
   * Chromium pierde memoria: arranca en ~1,2 GB y trepa hasta ~2,9 GB en unos
   * días. Como Railway factura el promedio de memoria por minuto ($10 por
   * GB-mes), esa pendiente es plata: el promedio de 7 días daba 2,3 GB, más que
   * TODOS los demás servicios de la cuenta juntos. Reciclar cada 24h corta la
   * pendiente cerca del piso.
   *
   * No es un workaround de algo arreglable acá: la fuga está adentro de
   * WhatsApp Web, no en este código.
   */
  reciclarCadaMs: numero("RECICLAR_CADA_MS", 24 * 60 * 60 * 1_000),

  /**
   * Techo del heap de V8 en el renderer, en MB.
   *
   * Sin esto V8 crece hasta donde haya RAM — y el límite del servicio es el del
   * plan, o sea 24 GB. Si el techo quedara corto, el renderer muere, WhatsApp
   * se desconecta y el proceso se reinicia (mismo camino que cualquier otra
   * desconexión); se ve como reinicios seguidos en los logs. Subirlo desde la
   * variable, no hace falta tocar código.
   */
  chromiumHeapMb: numero("CHROMIUM_HEAP_MB", 512),

  /**
   * Techo de la caché de disco de Chromium, en MB. Vive en el volumen: sin tope
   * crece para siempre y termina llenándolo.
   */
  chromiumCacheMb: numero("CHROMIUM_CACHE_MB", 100),

  /** Dónde vive la sesión de WhatsApp. En Railway tiene que ser un volumen. */
  dataPath: process.env.DATA_PATH || "/data",

  version: process.env.APP_VERSION || "1.0.0",
}
