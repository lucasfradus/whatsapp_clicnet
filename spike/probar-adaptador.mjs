/**
 * Chequeo de humo del adaptador de WhatsApp. No manda nada ni toca produccion:
 * usa un DATA_PATH descartable y un CLICNET_URL muerto a proposito.
 *
 *   node spike/probar-adaptador.mjs
 *
 * Verifica la interfaz que consume index.js y que el socket llegue a conectarse
 * con WhatsApp (hasta el QR). No valida la sesion vinculada: para eso hace falta
 * escanear, y eso lo hace spike/vincular-y-medir.mjs.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wa-smoke-"))
process.env.CLICNET_URL = "http://127.0.0.1:9"   // puerto muerto a proposito
process.env.SENDER_TOKEN = "spike"
process.env.DATA_PATH = tmp

const wa = await import("../src/whatsapp.js")

// Lo que index.js espera encontrar. Si esto se rompe, el servicio no arranca.
const ESPERADO = ["iniciarWhatsapp", "mandarMensaje", "listarGrupos", "estaConectado", "numeroConectado"]
let fallos = 0

console.log("\n=== interfaz que consume index.js ===")
for (const nombre of ESPERADO) {
  const tipo = typeof wa[nombre]
  const ok = tipo === "function"
  console.log(`  ${ok ? "OK   " : "FALLA"} ${nombre.padEnd(18)} ${tipo}`)
  if (!ok) fallos++
}

console.log("\n=== estado antes de conectar ===")
console.log("  estaConectado():", wa.estaConectado(), "| numeroConectado():", wa.numeroConectado())
console.log("  listarGrupos() sin sesion:", JSON.stringify(await wa.listarGrupos()))
try {
  await wa.mandarMensaje("123@g.us", "no deberia salir")
  console.log("  FALLA mandarMensaje no tiro sin conexion"); fallos++
} catch (e) {
  console.log("  OK    mandarMensaje tira sin conexion:", JSON.stringify(e.message))
}

console.log("\n=== conectando (espera el QR) ===")
const t0 = Date.now()
await wa.iniciarWhatsapp()
await new Promise((r) => setTimeout(r, 25_000))
const rss = process.memoryUsage().rss
console.log(`  RSS tras ${((Date.now() - t0) / 1000).toFixed(0)}s: ${(rss / 1024 ** 2).toFixed(1)} MB`)
console.log("  (indicativo: la medicion que vale es la del contenedor en Railway)")

await fs.rm(tmp, { recursive: true, force: true })
console.log(fallos === 0 ? "\n>>> TODO OK\n" : `\n>>> ${fallos} FALLO(S)\n`)
process.exit(fallos === 0 ? 0 : 1)
