/**
 * Smoke test del adaptador de Baileys. No toca produccion: usa un DATA_PATH
 * descartable y un CLICNET_URL que no existe (los POST fallan y se loguean,
 * que es justo lo que queremos comprobar que no rompe nada).
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "baileys-smoke-"))
process.env.CLICNET_URL = "http://127.0.0.1:9"   // puerto muerto a proposito
process.env.SENDER_TOKEN = "spike"
process.env.DATA_PATH = tmp

const viejo = await import("../src/whatsapp.js")
const nuevo = await import("../src/whatsapp-baileys.js")

const esperado = ["iniciarWhatsapp", "mandarMensaje", "listarGrupos", "estaConectado", "numeroConectado"]
let fallos = 0
console.log("\n=== interfaz ===")
for (const nombre of esperado) {
  const a = typeof viejo[nombre], b = typeof nuevo[nombre]
  const ok = a === "function" && b === "function"
  console.log(`  ${ok ? "OK " : "FALLA"} ${nombre.padEnd(18)} whatsapp.js=${a}  baileys=${b}`)
  if (!ok) fallos++
}
const extra = Object.keys(nuevo).filter(k => !esperado.includes(k))
console.log("  exports de mas:", extra.length ? extra.join(", ") : "(ninguno)")

console.log("\n=== antes de conectar ===")
console.log("  estaConectado():", nuevo.estaConectado(), "| numeroConectado():", nuevo.numeroConectado())
console.log("  listarGrupos() sin sesion:", JSON.stringify(await nuevo.listarGrupos()))
try {
  await nuevo.mandarMensaje("123@g.us", "no deberia salir")
  console.log("  FALLA: mandarMensaje no tiro sin conexion"); fallos++
} catch (e) {
  console.log("  OK  mandarMensaje tira sin conexion:", JSON.stringify(e.message))
}

console.log("\n=== conectando (espera el QR) ===")
const t0 = Date.now()
await nuevo.iniciarWhatsapp()
await new Promise((r) => setTimeout(r, 25_000))
console.log(`  RSS tras ${((Date.now()-t0)/1000).toFixed(0)}s:`, (process.memoryUsage().rss/1024**2).toFixed(1), "MB")

const enDisco = await fs.readdir(path.join(tmp, "baileys")).catch(() => [])
console.log("  auth state en disco:", enDisco.length, "archivo(s):", enDisco.slice(0,4).join(", "))
let bytes = 0
for (const f of enDisco) bytes += (await fs.stat(path.join(tmp, "baileys", f))).size
console.log("  peso del auth state:", (bytes/1024).toFixed(1), "KB   <-- comparar con 3,3 GB de volumen")

await fs.rm(tmp, { recursive: true, force: true })
console.log(fallos === 0 ? "\n>>> TODO OK\n" : `\n>>> ${fallos} FALLO(S)\n`)
process.exit(fallos === 0 ? 0 : 1)
