import { config } from "./config.js"

/**
 * Cliente HTTP contra Clicnet. Todos los endpoints piden el header X-Sender-Token.
 *
 * Ninguna de estas funciones tira: si Clicnet no responde, el loop tiene que
 * seguir vivo y reintentar en el próximo tick. Devuelven null en el error.
 */

const TIMEOUT_MS = 15_000

async function pedir(ruta, opciones = {}) {
  const controlador = new AbortController()
  const timeout = setTimeout(() => controlador.abort(), TIMEOUT_MS)

  try {
    const respuesta = await fetch(`${config.clicnetUrl}${ruta}`, {
      ...opciones,
      signal: controlador.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Sender-Token": config.token,
        ...opciones.headers,
      },
    })

    if (!respuesta.ok) {
      console.error(`[clicnet] ${ruta} respondió ${respuesta.status}`)
      return null
    }

    // Chequear el content-type antes de parsear: si el endpoint todavía no
    // existe (o hay un proxy en el medio), lo que vuelve es una página HTML con
    // status 200 y `.json()` explota con un "Unexpected token '<'" que no dice
    // nada. Mejor un mensaje que se entienda.
    const tipo = respuesta.headers.get("content-type") ?? ""
    if (!tipo.includes("application/json")) {
      console.error(
        `[clicnet] ${ruta} devolvió ${tipo || "sin content-type"} en vez de JSON ` +
          `— ¿está deployada la versión de Clicnet con los endpoints del sender?`
      )
      return null
    }

    return await respuesta.json()
  } catch (error) {
    console.error(`[clicnet] ${ruta} falló:`, error.message)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Mensajes pendientes de mandar. */
export async function traerCola() {
  const datos = await pedir("/api/whatsapp-sender/cola")
  return datos?.mensajes ?? []
}

/** Cómo salió cada mensaje: [{ id, ok, error? }] */
export async function reportarResultados(resultados) {
  if (resultados.length === 0) return
  await pedir("/api/whatsapp-sender/resultado", {
    method: "POST",
    body: JSON.stringify({ resultados }),
  })
}

/** Latido + lista de grupos para el selector de destinos de Clicnet. */
export async function latir({ conectado, numero, grupos }) {
  await pedir("/api/whatsapp-sender/heartbeat", {
    method: "POST",
    body: JSON.stringify({ conectado, numero, grupos, version: config.version }),
  })
}

/** Publica el QR para que alguien lo escanee desde Clicnet. */
export async function publicarQr(qrDataUrl) {
  await pedir("/api/whatsapp-sender/qr", {
    method: "POST",
    body: JSON.stringify({ qr: qrDataUrl }),
  })
}
