import http from "node:http"
import { config } from "./config.js"
import { traerCola, reportarResultados, latir } from "./clicnet.js"
import {
  iniciarWhatsapp,
  mandarMensaje,
  listarGrupos,
  estaConectado,
  numeroConectado,
} from "./whatsapp.js"

/**
 * clic-whatsapp-sender
 *
 * Un loop, tres cosas:
 *  1. pide la cola de mensajes a Clicnet,
 *  2. los manda por WhatsApp Web espaciados,
 *  3. reporta cómo salió cada uno.
 *
 * Clicnet es el dueño de la cola: acá no se guarda estado. Si este servicio se
 * cae, los mensajes quedan PENDIENTE y salen cuando vuelve.
 */

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

let procesando = false

async function procesarCola() {
  // El poll y el envío no son atómicos: si un lote tarda más que el intervalo,
  // el tick siguiente traería los MISMOS mensajes (Clicnet no los marca al
  // entregarlos) y se mandarían dos veces. Este flag es el que lo evita.
  if (procesando) return
  if (!estaConectado()) return

  procesando = true
  try {
    const mensajes = await traerCola()
    if (mensajes.length === 0) return

    console.log(`[cola] ${mensajes.length} mensaje(s) para mandar`)
    const resultados = []

    for (const [indice, mensaje] of mensajes.entries()) {
      if (indice > 0) await dormir(config.delayEnvioMs)

      try {
        await mandarMensaje(mensaje.chatId, mensaje.texto)
        resultados.push({ id: mensaje.id, ok: true })
        console.log(`[cola] #${mensaje.id} → ${mensaje.chatId}`)
      } catch (error) {
        resultados.push({ id: mensaje.id, ok: false, error: error.message })
        console.error(`[cola] #${mensaje.id} falló:`, error.message)

        // Si se cayó la sesión, cortamos el lote: el resto se reintenta cuando
        // vuelva. Seguir sería quemar los 3 intentos de cada mensaje al pedo.
        if (!estaConectado()) break
      }
    }

    await reportarResultados(resultados)
  } catch (error) {
    console.error("[cola] error inesperado:", error.message)
  } finally {
    procesando = false
  }
}

async function heartbeat() {
  try {
    await latir({
      conectado: estaConectado(),
      numero: numeroConectado(),
      grupos: await listarGrupos(),
    })
  } catch (error) {
    console.error("[heartbeat] error:", error.message)
  }
}

/**
 * Healthcheck para Railway. Responde 200 con que el PROCESO está vivo, no con
 * que WhatsApp esté vinculado.
 *
 * La diferencia importa: si devolviera 503 sin sesión, Railway mataría y
 * reiniciaría el contenedor en loop, y nunca habría chance de escanear el QR
 * — hace falta que el servicio esté corriendo para publicarlo. El estado real
 * de la sesión se ve en Clicnet, que es donde alguien lo va a mirar.
 */
function levantarHealthcheck() {
  const puerto = Number(process.env.PORT) || 3000
  http
    .createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ vivo: true, conectado: estaConectado(), numero: numeroConectado() }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    .listen(puerto, () => console.log(`[http] healthcheck en :${puerto}/health`))
}

async function main() {
  console.log(`[sender] arrancando v${config.version} contra ${config.clicnetUrl}`)
  levantarHealthcheck()

  await iniciarWhatsapp()

  await heartbeat()
  setInterval(heartbeat, config.heartbeatIntervalMs)
  setInterval(procesarCola, config.pollIntervalMs)
}

main().catch((error) => {
  console.error("[sender] no pudo arrancar:", error)
  process.exit(1)
})
