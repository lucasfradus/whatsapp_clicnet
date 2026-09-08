/**
 * Vincula Baileys al numero de Clic como DISPOSITIVO ADICIONAL y mide lo que
 * falto en el spike anterior. No toca produccion:
 *
 *  - no le pega a Clicnet (el QR sale a un PNG local, no a la pantalla de
 *    Sedes -> Avisos por WhatsApp);
 *  - no usa el volumen de Railway (auth state en .data/, que esta gitignoreado);
 *  - WhatsApp admite hasta 4 dispositivos vinculados en paralelo, asi que el
 *    whatsapp-web.js de produccion sigue conectado y mandando igual.
 *
 * No manda nada a ningun grupo de sede. Para probar el envio se manda un
 * mensaje al PROPIO numero, que no molesta a nadie.
 */
import fs from "node:fs/promises"
import path from "node:path"
import QRCode from "qrcode"
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from "baileys"

const AUTH = path.resolve(".data/baileys-spike")
const PNG = path.resolve(".data/qr-baileys.png")
const ESPERA_MS = 10 * 60 * 1000

const mb = (b) => (b / 1024 ** 2).toFixed(1)
const mudo = { level: "silent", child: () => mudo, trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){} }

async function pesoDe(dir) {
  let total = 0, n = 0
  for (const f of await fs.readdir(dir).catch(() => [])) {
    try { total += (await fs.stat(path.join(dir, f))).size; n++ } catch {}
  }
  return { total, n }
}

await fs.mkdir(AUTH, { recursive: true })
const { state, saveCreds } = await useMultiFileAuthState(AUTH)

const sock = makeWASocket({
  auth: state,
  browser: Browsers.ubuntu("Clic Sender (spike)"),
  logger: mudo,
  syncFullHistory: false,
  markOnlineOnConnect: false,
  cachedGroupMetadata: async () => undefined,
})
sock.ev.on("creds.update", saveCreds)

let qrs = 0
const resultado = await new Promise((resolve) => {
  const limite = setTimeout(() => resolve({ ok: false, motivo: "nadie escaneo el QR en 10 minutos" }), ESPERA_MS)

  sock.ev.on("connection.update", async (u) => {
    if (u.qr) {
      qrs++
      await QRCode.toFile(PNG, u.qr, { width: 512, margin: 2 })
      console.log(`[qr] QR #${qrs} escrito en ${PNG} — escanealo (se renueva solo)`)
      return
    }
    if (u.connection === "open") { clearTimeout(limite); resolve({ ok: true }) }
    if (u.connection === "close") {
      const codigo = u.lastDisconnect?.error?.output?.statusCode
      if (codigo === DisconnectReason.loggedOut) { clearTimeout(limite); resolve({ ok: false, motivo: "loggedOut" }) }
      // cualquier otro cierre: Baileys reintenta solo, no resolvemos
    }
  })
})

if (!resultado.ok) {
  console.log(`\n>>> NO SE VINCULO: ${resultado.motivo}\n`)
  await fs.rm(AUTH, { recursive: true, force: true }).catch(() => {})
  process.exit(1)
}

const numero = sock.user?.id?.split(":")[0]?.split("@")[0] ?? "?"
console.log(`\n=== VINCULADO como ${numero} ===\n`)

// Que se asiente: al vincular llegan sesiones de Signal y metadata.
await new Promise((r) => setTimeout(r, 30_000))
const rssTrasVincular = process.memoryUsage().rss
console.log(`  RSS con sesion real: ${mb(rssTrasVincular)} MB   <-- el numero que faltaba`)

console.log("\n=== GRUPOS (groupFetchAllParticipating) ===")
let grupos = {}
try {
  grupos = await sock.groupFetchAllParticipating()
  const lista = Object.entries(grupos)
  console.log(`  ${lista.length} grupo(s):`)
  for (const [jid, meta] of lista) {
    console.log(`    ${meta?.subject ?? "(SIN NOMBRE)"}  ·  ${meta?.participants?.length ?? "?"} participantes  ·  ${jid}`)
  }
  const conNombre = lista.filter(([, m]) => m?.subject).length
  console.log(`  => ${conNombre}/${lista.length} con nombre  ${conNombre === lista.length ? "(getChats() roto queda resuelto)" : "(OJO: faltan nombres)"}`)
} catch (error) {
  console.log("  FALLO groupFetchAllParticipating():", error.message)
}

console.log("\n=== ENVIO (al propio numero, no a un grupo) ===")
try {
  await sock.sendMessage(`${numero}@s.whatsapp.net`, { text: "Prueba de Baileys desde el spike de Clicnet. Si llega esto, el envio anda." })
  console.log("  OK  sendMessage no tiro — fijate si te llego el mensaje al WhatsApp de Clic")
} catch (error) {
  console.log("  FALLO sendMessage:", error.message)
}

const rssFinal = process.memoryUsage().rss
const peso = await pesoDe(AUTH)
console.log("\n=== RESUMEN ===")
console.log(`  RSS final          : ${mb(rssFinal)} MB`)
console.log(`  piso de Chromium   : 836.0 MB`)
console.log(`  => ${(836 / (rssFinal / 1024 ** 2)).toFixed(1)}x menos memoria`)
console.log(`  costo estimado     : $${((rssFinal / 1024 ** 3) * 10).toFixed(2)}/mes  (hoy: ~$10)`)
console.log(`  auth state         : ${peso.n} archivos, ${(peso.total / 1024).toFixed(1)} KB   <-- volumen actual: 3,3 GB`)
console.log("\n  (el auth state queda en .data/, gitignoreado; borralo cuando quieras")
console.log("   y desvincula el dispositivo desde el celular: WhatsApp -> Dispositivos vinculados)\n")

try { sock.end() } catch {}
process.exit(0)
