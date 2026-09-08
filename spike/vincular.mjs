/**
 * Vincula Baileys al número de Clic. Una sola pantalla, siempre vigente.
 *
 *   node spike/vincular.mjs 5491162371507
 *   -> abrir http://localhost:8899
 *
 * El problema de los intentos anteriores era que ni el QR ni el código se
 * podían mirar: el QR rota cada ~20s sobre un archivo que se pisa, y el código
 * de vinculación expira al minuto y se generaba UNA sola vez. Acá la página
 * pregunta el estado cada 2s y muestra siempre lo vigente, con la antigüedad a
 * la vista para que se note si algo se congeló.
 *
 * No toca producción: auth state descartable en .data/, no le pega a Clicnet.
 * WhatsApp admite hasta 4 dispositivos, así que el sender sigue andando.
 */
import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import QRCode from "qrcode"
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from "baileys"

const numeroTel = (process.argv[2] ?? "").replace(/[^0-9]/g, "")
if (!numeroTel) {
  console.error("Falta el número. Ej: node spike/vincular.mjs 5491162371507")
  process.exit(1)
}

const AUTH = path.resolve(".data/baileys-vinculo")
const PUERTO = 8899
const CODIGO_CADA_MS = 90_000
const VENTANA_MS = 45 * 60 * 1000   // margen para que no haya que correr contra el reloj
const mb = (b) => (b / 1024 ** 2).toFixed(1)
const mudo = { level: "silent", child: () => mudo, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }

const estado = { codigo: null, codigoEn: 0, qr: null, qrEn: 0, conexion: "arrancando", error: null }

const PAGINA = [
  "<!doctype html><meta charset=utf-8><title>Vincular Baileys</title>",
  "<style>",
  "body{font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:2rem;text-align:center;color:#111}",
  ".codigo{font-size:3rem;letter-spacing:.25em;font-weight:700;font-family:ui-monospace,monospace;margin:.4rem 0}",
  ".edad{color:#666;font-size:.85rem}.mal{color:#b00}",
  "img{border:1px solid #ddd;border-radius:8px;width:340px;height:340px}",
  ".caja{border:1px solid #ddd;border-radius:12px;padding:1.2rem;margin:1.2rem 0}",
  ".ok{background:#e8f5e9;border-color:#4caf50}",
  "</style><body>",
  "<h2>Vincular Baileys — prueba</h2>",
  "<p style=color:#666>No toca produccion. El sender sigue andando con whatsapp-web.js.</p>",
  "<div id=todo>cargando...</div>",
  "<script>",
  "async function tick(){",
  " try{",
  "  const d = await (await fetch('/estado?t='+Date.now())).json();",
  "  let h='';",
  "  if(d.conexion==='abierta'){",
  "   h='<div class=\"caja ok\"><h3>VINCULADO</h3><p>Ya podes cerrar esta pagina. Los resultados salen por la terminal.</p></div>';",
  "  } else {",
  "   if(d.codigo){",
  "    h+='<div class=caja><p>Opcion 1 &mdash; <b>Vincular con numero de telefono</b></p>';",
  "    h+='<div class=codigo>'+d.codigo+'</div>';",
  "    h+='<p class=\"edad'+(d.codigoHace>110?' mal':'')+'\">generado hace '+d.codigoHace+'s</p></div>';",
  "   }",
  "   if(d.qr){",
  "    h+='<div class=caja><p>Opcion 2 &mdash; escanear el QR</p><img src=\"'+d.qr+'\">';",
  "    h+='<p class=\"edad'+(d.qrHace>40?' mal':'')+'\">actualizado hace '+d.qrHace+'s</p></div>';",
  "   }",
  "   if(!d.codigo && !d.qr) h='<p>esperando a WhatsApp... ('+d.conexion+')</p>';",
  "   if(d.error) h+='<p class=mal>'+d.error+'</p>';",
  "  }",
  "  document.getElementById('todo').innerHTML=h;",
  " }catch(e){ document.getElementById('todo').innerHTML='<p class=mal>se corto el script</p>'; }",
  "}",
  "tick(); setInterval(tick,2000);",
  "</script></body>",
].join("\n")

const hace = (t) => (t ? Math.round((Date.now() - t) / 1000) : null)

http
  .createServer((req, res) => {
    if (req.url.startsWith("/estado")) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      return res.end(
        JSON.stringify({
          codigo: estado.codigo,
          codigoHace: hace(estado.codigoEn),
          qr: estado.qr,
          qrHace: hace(estado.qrEn),
          conexion: estado.conexion,
          error: estado.error,
        })
      )
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(PAGINA)
  })
  .listen(PUERTO, () => {
    console.log(`\n  >>> ABRIR:  http://localhost:${PUERTO}\n`)
    console.log("  La pagina muestra el codigo Y el QR, los dos siempre vigentes.\n")
  })

await fs.mkdir(AUTH, { recursive: true })
const { state, saveCreds } = await useMultiFileAuthState(AUTH)

let sock = null

/** Los códigos vencen al minuto y pico, así que hay que renovarlos solos. */
async function pedirCodigo() {
  if (!sock || sock.authState.creds.registered) return
  try {
    estado.codigo = await sock.requestPairingCode(numeroTel)
    estado.codigoEn = Date.now()
    estado.error = null
    console.log(`[codigo] ${estado.codigo}`)
  } catch (error) {
    // Normal justo después de un cierre: el socket nuevo todavía no abrió.
    // Se reintenta solo en el próximo ciclo.
    estado.error = "renovando…"
    console.error("[codigo] falló:", error.message)
  }
}

const listo = await new Promise((resolve) => {
  const limite = setTimeout(
    () => resolve({ ok: false, motivo: `${VENTANA_MS / 60000} minutos sin completar la vinculación` }),
    VENTANA_MS
  )
  setInterval(pedirCodigo, CODIGO_CADA_MS)

  function conectar() {
    sock = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu("Clic Sender"),
      logger: mudo,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      cachedGroupMetadata: async () => undefined,
    })
    sock.ev.on("creds.update", saveCreds)

    let primerQr = true
    sock.ev.on("connection.update", async (u) => {
      if (u.qr) {
        estado.qr = await QRCode.toDataURL(u.qr, { width: 340, margin: 1 })
        estado.qrEn = Date.now()
        estado.conexion = "esperando vinculación"
        if (primerQr) {
          // El primer QR significa que el canal de registro quedó abierto:
          // recién ahí tiene sentido pedir el código.
          primerQr = false
          await pedirCodigo()
        }
        return
      }

      if (u.connection === "open") {
        estado.conexion = "abierta"
        clearTimeout(limite)
        return resolve({ ok: true })
      }

      if (u.connection === "close") {
        const cod = u.lastDisconnect?.error?.output?.statusCode
        console.log(`[conexión] cerrada (${cod ?? "sin código"})`)

        if (cod === DisconnectReason.loggedOut) {
          clearTimeout(limite)
          return resolve({ ok: false, motivo: "loggedOut" })
        }

        // WhatsApp cierra el socket a los ~5 QRs sin escanear (408). Si no
        // reconectamos, la página queda mostrando un código y un QR muertos
        // y todo pedido nuevo falla con "Connection Closed". Reconectar es lo
        // que hace que la pantalla siga sirviendo toda la ventana.
        estado.conexion = "reconectando"
        setTimeout(conectar, 2_000)
      }
    })
  }

  conectar()
})

if (!listo.ok) {
  console.log(`\n>>> NO SE VINCULÓ: ${listo.motivo}\n`)
  process.exit(1)
}

const numero = sock.user?.id?.split(":")[0]?.split("@")[0] ?? "?"
console.log(`\n=== VINCULADO como ${numero} ===\n`)
await new Promise((r) => setTimeout(r, 30_000))
console.log(`  RSS con sesión real: ${mb(process.memoryUsage().rss)} MB`)

console.log("\n=== GRUPOS ===")
try {
  const lista = Object.entries(await sock.groupFetchAllParticipating())
  console.log(`  ${lista.length} grupo(s):`)
  for (const [jid, meta] of lista) console.log(`    ${meta?.subject ?? "(SIN NOMBRE)"}  ·  ${jid}`)
  console.log(`  => ${lista.filter(([, m]) => m?.subject).length}/${lista.length} con nombre`)
} catch (e) {
  console.log("  FALLO groupFetchAllParticipating():", e.message)
}

console.log("\n=== ENVÍO (al propio número, no a un grupo) ===")
try {
  await sock.sendMessage(`${numero}@s.whatsapp.net`, { text: "Prueba de Baileys desde el spike de Clicnet." })
  console.log("  OK  sendMessage no tiró")
} catch (e) {
  console.log("  FALLO sendMessage:", e.message)
}

const rss = process.memoryUsage().rss
let bytes = 0
let n = 0
for (const f of await fs.readdir(AUTH).catch(() => [])) {
  bytes += (await fs.stat(path.join(AUTH, f))).size
  n++
}
console.log("\n=== RESUMEN ===")
console.log(`  RSS: ${mb(rss)} MB  vs 836 MB de Chromium  => ${(836 / (rss / 1024 ** 2)).toFixed(1)}x menos`)
console.log(`  costo estimado: $${((rss / 1024 ** 3) * 10).toFixed(2)}/mes`)
console.log(`  auth state: ${n} archivos, ${(bytes / 1024).toFixed(1)} KB\n`)
process.exit(0)
