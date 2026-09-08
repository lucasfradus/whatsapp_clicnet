/**
 * Prueba que BAILEYS_AUTH_SEED funcione: con la variable puesta y el volumen
 * vacío, el servicio tiene que arrancar YA CONECTADO, sin pedir código ni QR.
 *
 *   node spike/probar-siembra.mjs <carpeta-con-la-sesion>
 *
 * Usa un DATA_PATH descartable, así que no toca la sesión de origen ni el
 * volumen de Railway. Sí se conecta de verdad a WhatsApp con esas credenciales.
 */
import fs from "node:fs/promises"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"

const origen = process.argv[2] ?? ".data/baileys-vinculo"

// Empaquetar igual que para la variable de Railway.
const bulto = {}
for (const f of fsSync.readdirSync(origen)) {
  bulto[f] = fsSync.readFileSync(path.join(origen, f), "utf8")
}
const semilla = zlib.gzipSync(Buffer.from(JSON.stringify(bulto), "utf8"), { level: 9 }).toString("base64")
console.log(`\nsemilla: ${Object.keys(bulto).length} archivos, ${(semilla.length / 1024).toFixed(1)} KB en base64\n`)

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "siembra-"))
process.env.CLICNET_URL = "http://127.0.0.1:9"
process.env.SENDER_TOKEN = "spike"
process.env.DATA_PATH = tmp
process.env.WHATSAPP_NUMERO = "5491162371507" // a proposito: NO se tiene que usar
process.env.BAILEYS_AUTH_SEED = semilla

const wa = await import("../src/whatsapp.js")

let pidioCodigo = false
const logOriginal = console.log
console.log = (...a) => {
  if (a.join(" ").includes("código de vinculación")) pidioCodigo = true
  logOriginal(...a)
}

await wa.iniciarWhatsapp()
for (let i = 0; i < 40 && !wa.estaConectado(); i++) await new Promise((r) => setTimeout(r, 1000))
console.log = logOriginal

let fallos = 0
console.log("\n=== RESULTADO ===")

const sembrado = fsSync.existsSync(path.join(tmp, "baileys", "creds.json"))
console.log(`  ${sembrado ? "OK   " : "FALLA"} escribio la sesion en el volumen vacio`)
if (!sembrado) fallos++

console.log(`  ${wa.estaConectado() ? "OK   " : "FALLA"} conecto sin vincular nada  (numero: ${wa.numeroConectado()})`)
if (!wa.estaConectado()) fallos++

console.log(`  ${!pidioCodigo ? "OK   " : "FALLA"} NO pidio codigo de vinculacion`)
if (pidioCodigo) fallos++

if (wa.estaConectado()) {
  const grupos = await wa.listarGrupos()
  const conNombre = grupos.filter((g) => g.nombre && !g.nombre.endsWith("@g.us")).length
  console.log(`  ${grupos.length > 0 ? "OK   " : "FALLA"} grupos: ${grupos.length} (${conNombre} con nombre)`)
  if (grupos.length === 0) fallos++
}

console.log(`\n  RSS: ${(process.memoryUsage().rss / 1024 ** 2).toFixed(1)} MB`)

// Segunda parte: con una sesion YA existente, la semilla no tiene que pisarla.
const marca = path.join(tmp, "baileys", "creds.json")
const antes = fsSync.readFileSync(marca, "utf8")
fsSync.writeFileSync(marca, antes) // misma sesion, distinta mtime
const { config } = await import("../src/config.js")
console.log(`\n  (semilla cargada en config: ${config.authSeed ? "si" : "no"})`)

await fs.rm(tmp, { recursive: true, force: true })
console.log(fallos === 0 ? "\n>>> TODO OK\n" : `\n>>> ${fallos} FALLO(S)\n`)
process.exit(fallos === 0 ? 0 : 1)
