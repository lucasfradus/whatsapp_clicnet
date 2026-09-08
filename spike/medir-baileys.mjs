/**
 * Mide cuánta memoria usa Baileys, que es la única pregunta que decide si
 * conviene migrar. No manda nada ni toca la sesión de producción: levanta un
 * socket con un auth state vacío y descartable, espera el QR y mide.
 *
 *   node spike/medir-baileys.mjs
 *
 * Ojo con lo que mide y lo que no: sin número vinculado no hay sesiones de
 * Signal ni metadata de grupos, así que el número real conectado va a ser algo
 * más alto. Sirve para el orden de magnitud, no para el número final.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const mb = (bytes) => (bytes / 1024 ** 2).toFixed(1)
const marcas = []
function marcar(etiqueta) {
  const { rss, heapUsed } = process.memoryUsage()
  marcas.push({ etiqueta, rss, heapUsed })
  console.log(`  ${etiqueta.padEnd(28)} RSS ${mb(rss).padStart(7)} MB   heap ${mb(heapUsed).padStart(7)} MB`)
}

console.log("\n=== Baileys: huella de memoria ===\n")
marcar("node pelado")

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } =
  await import("baileys")
marcar("despues del import")

const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "baileys-spike-"))
const { state, saveCreds } = await useMultiFileAuthState(authDir)
marcar("auth state vacio")

const sock = makeWASocket({
  auth: state,
  browser: Browsers.ubuntu("Clic Sender"),
  // Sin esto Baileys baja TODO el historial de mensajes al vincular. No lo
  // necesitamos —sólo mandamos— y es justo lo que haría crecer la memoria.
  syncFullHistory: false,
  markOnlineOnConnect: false,
  logger: { level: "silent", child: () => ({ level: "silent", child: () => ({}), trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){} }), trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){} },
})
sock.ev.on("creds.update", saveCreds)
marcar("socket creado")

const listo = new Promise((resolve) => {
  let visto = false
  sock.ev.on("connection.update", (u) => {
    if (u.qr && !visto) {
      visto = true
      marcar("QR recibido (conectado a WA)")
      resolve("qr")
    }
    if (u.connection === "close") {
      const codigo = u.lastDisconnect?.error?.output?.statusCode
      if (codigo !== DisconnectReason.restartRequired) resolve("cerrado:" + codigo)
    }
  })
  setTimeout(() => resolve("timeout"), 45_000)
})

const motivo = await listo
console.log(`\n  (fin de la espera: ${motivo})\n`)

// Un rato quieto: si hubiera una fuga obvia, acá se empieza a ver.
await new Promise((r) => setTimeout(r, 20_000))
marcar("tras 20s quieto")
global.gc?.()
if (global.gc) marcar("tras GC forzado")

const pico = Math.max(...marcas.map((m) => m.rss))
console.log(`\n  PICO RSS: ${mb(pico)} MB`)
console.log(`  Chromium en produccion (piso medido): 836.0 MB`)
console.log(`  => ${(836 / (pico / 1024 ** 2)).toFixed(1)}x menos\n`)

try { sock.end() } catch {}
await fs.rm(authDir, { recursive: true, force: true })
process.exit(0)
