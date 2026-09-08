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
   * Esto nació como el parche de la fuga de Chromium, que costaba ~0,38 GB por
   * día y se comía la factura. Con Baileys esa fuga no existe, así que **ya no
   * es un arreglo: es un seguro**. Queda por 7 días para acotar cualquier
   * deriva que no hayamos visto todavía, y porque un reinicio de este servicio
   * es barato (reconecta desde el auth state, sin QR). Si en unos meses la
   * memoria se ve plana, se puede sacar del todo.
   */
  reciclarCadaMs: numero("RECICLAR_CADA_MS", 7 * 24 * 60 * 60 * 1_000),

  /**
   * Número de la cuenta, en formato internacional sin `+` (ej. 5491162371507).
   *
   * Si está, la vinculación va por **código** en vez de por QR: el servicio
   * pide un código de 8 caracteres y lo publica en la misma pantalla de
   * Clicnet. Es el camino recomendado, por dos razones medidas:
   *
   *  - el QR rota cada ~20s y en la práctica es difícil escanear el vigente;
   *  - hay un bug abierto de WhatsApp/Baileys en el flujo del QR
   *    ([#2737](https://github.com/WhiskeySockets/Baileys/issues/2737)) que el
   *    camino del código no toca. Vincular por código está verificado con este
   *    número; por QR, no.
   *
   * Si no está, se cae al QR de siempre.
   */
  numeroVinculacion: (process.env.WHATSAPP_NUMERO ?? "").replace(/[^0-9]/g, "") || null,

  /**
   * Auth state ya vinculado, para sembrar el volumen en el primer arranque.
   * Es el JSON de la carpeta de sesión, gzippeado y en base64 (~10 KB).
   *
   * Existe porque vincular desde cero necesita **dos** cosas que no siempre
   * están: un lugar libre en la lista de dispositivos de WhatsApp (son 4, y
   * con la lista llena rechaza sin decir por qué) y alguien con el celular a
   * mano en el momento justo, porque los códigos vencen al minuto. Con una
   * sesión ya vinculada y verificada, traerla es determinístico: el servicio
   * arranca conectado y no hay nada que vincular.
   *
   * Sólo se usa si el volumen NO tiene sesión. Una vez sembrado es inerte y
   * **conviene borrar la variable**: son credenciales.
   */
  authSeed: process.env.BAILEYS_AUTH_SEED || null,

  /** Dónde vive el auth state. En Railway tiene que ser un volumen. */
  dataPath: process.env.DATA_PATH || "/data",

  version: process.env.APP_VERSION || "1.0.0",
}
