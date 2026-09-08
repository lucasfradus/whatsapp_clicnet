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

const arrancadoEn = Date.now()

/**
 * Sale del proceso cada tanto para que Railway levante uno nuevo.
 *
 * Nació como el parche de la fuga de Chromium; con Baileys esa fuga no existe,
 * así que ahora es un **seguro** contra una deriva que no hayamos visto, no un
 * arreglo. Por eso el intervalo pasó de 24h a 7 días. Salimos con 0: es una
 * terminación buscada, no un fallo, y el `restartPolicyType: ALWAYS` del
 * railway.json es lo que hace que Railway lo levante igual.
 *
 * Se llama sólo cuando la cola vino vacía, que es el único momento en que no hay
 * nada en vuelo. Si Clicnet no contestó, la cola también se ve vacía y podemos
 * reciclar de más — no importa: Clicnet es el dueño de la cola, los mensajes
 * quedan PENDIENTE y salen apenas volvemos.
 */
function reciclarSiCorresponde() {
  const vividoMs = Date.now() - arrancadoEn
  if (vividoMs < config.reciclarCadaMs) return

  const horas = (vividoMs / 3_600_000).toFixed(1)
  console.log(`[sender] reciclando tras ${horas}h con la cola vacía; Railway levanta un proceso nuevo`)
  process.exit(0)
}

async function procesarCola() {
  // El poll y el envío no son atómicos: si un lote tarda más que el intervalo,
  // el tick siguiente traería los MISMOS mensajes (Clicnet no los marca al
  // entregarlos) y se mandarían dos veces. Este flag es el que lo evita.
  if (procesando) return
  if (!estaConectado()) return

  procesando = true
  let colaVacia = false
  try {
    const mensajes = await traerCola()
    if (mensajes.length === 0) {
      // Ojo: `return` acá adentro haría que el reciclado del final nunca corra,
      // porque el `return` gana sobre el código que sigue al try/finally.
      colaVacia = true
    } else {
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
    }
  } catch (error) {
    console.error("[cola] error inesperado:", error.message)
  } finally {
    procesando = false
  }

  if (colaVacia) reciclarSiCorresponde()
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
