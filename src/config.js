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

  /** Dónde vive la sesión de WhatsApp. En Railway tiene que ser un volumen. */
  dataPath: process.env.DATA_PATH || "/data",

  version: process.env.APP_VERSION || "1.0.0",
}
