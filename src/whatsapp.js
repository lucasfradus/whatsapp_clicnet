import fs from "node:fs/promises"
import path from "node:path"
import zlib from "node:zlib"
import QRCode from "qrcode"
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} from "baileys"
import { config } from "./config.js"
import { publicarQr } from "./clicnet.js"

/**
 * Sesión de WhatsApp Web.
 *
 * Es UNA sola para toda la cadena: el número de Clic está en los grupos de las
 * 14 sedes. El auth state vive en `dataPath`, que en Railway es un volumen —
 * sin eso, cada deploy pide QR de nuevo.
 *
 * **Acá NO hay navegador.** Baileys habla el protocolo multi-device de WhatsApp
 * directo por WebSocket. Antes esto era whatsapp-web.js, o sea un Chromium
 * headless, y ese Chromium era el problema: perdía memoria a ~0,38 GB por día
 * y con un piso de 836 MB era el servicio más caro de toda la cuenta de
 * Railway. Al sacarlo se fueron de una tres cosas más:
 *
 *  - el volumen de 3,3 GB (el auth state son unos JSON de pocos KB), y con él
 *    toda la familia de bugs del SingletonLock;
 *  - `getChats()`, roto hacía meses, que dejaba el selector de destinos con
 *    JIDs crudos. Acá los grupos salen de `groupFetchAllParticipating()`;
 *  - el `exit(1)` en cada desconexión: sin Chromium que quede colgado,
 *    reconectar en caliente es lo correcto.
 *
 * Si alguien propone volver a whatsapp-web.js, esa es la lista de lo que se
 * vuelve a comprar.
 */

let sock = null
let conectado = false
let numero = null
let reconectando = false

/** Baileys espera un logger tipo pino. No queremos su ruido en los logs. */
const mudo = {
  level: "silent",
  child: () => mudo,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
}

/** Dónde vive el auth state. Son unos JSON chicos, no un perfil de navegador. */
const authDir = () => path.join(config.dataPath, "baileys")

/**
 * Metadata de grupos, cacheada.
 *
 * No es una optimización: al mandar a un grupo Baileys necesita la lista de
 * participantes para cifrarle a cada uno, y si no se la damos la pide a
 * WhatsApp en CADA envío. Eso es lo que dispara rate limits y baneos — y acá
 * TODOS los mensajes van a grupos.
 */
const CACHE_MS = 5 * 60 * 1_000
const cacheGrupos = new Map() // jid -> { metadata, expira }

function cachear(jid, metadata) {
  if (metadata) cacheGrupos.set(jid, { metadata, expira: Date.now() + CACHE_MS })
}

function delCache(jid) {
  const entrada = cacheGrupos.get(jid)
  if (!entrada) return undefined
  if (entrada.expira < Date.now()) {
    cacheGrupos.delete(jid)
    return undefined
  }
  return entrada.metadata
}

/** Nombres de grupo conocidos, para el selector de destinos de Clicnet. */
const grupos = new Map() // jid -> { nombre, pista }

export function estaConectado() {
  return conectado
}

export function numeroConectado() {
  return numero
}

export async function iniciarWhatsapp() {
  await conectar()
}

/**
 * Escribe en el volumen un auth state ya vinculado, si no hay ninguno.
 *
 * Ver el comentario de `authSeed` en config.js para el porqué. Lo importante
 * acá: **no pisa una sesión existente**. Si el volumen ya tiene `creds.json`,
 * esta función no hace nada, así que dejar la variable puesta por olvido no
 * puede romper una sesión que está andando.
 */
async function sembrarAuthState(dir) {
  if (!config.authSeed) return

  try {
    await fs.access(path.join(dir, "creds.json"))
    return // ya hay sesión: no tocamos nada
  } catch {
    /* no hay sesión: sembramos */
  }

  try {
    const json = zlib.gunzipSync(Buffer.from(config.authSeed, "base64")).toString("utf8")
    const archivos = JSON.parse(json)
    let escritos = 0
    for (const [nombre, contenido] of Object.entries(archivos)) {
      // El nombre viene de una variable de entorno: que no se pueda escribir
      // fuera del directorio de la sesión.
      if (nombre.includes("/") || nombre.includes("\\") || nombre.startsWith(".")) continue
      await fs.writeFile(path.join(dir, nombre), contenido, "utf8")
      escritos++
    }
    console.log(`[whatsapp] auth state sembrado desde BAILEYS_AUTH_SEED (${escritos} archivos)`)
  } catch (error) {
    console.error("[whatsapp] no se pudo sembrar el auth state:", error.message)
  }
}

async function conectar() {
  const dir = authDir()
  await fs.mkdir(dir, { recursive: true })
  await sembrarAuthState(dir)
  const { state, saveCreds } = await useMultiFileAuthState(dir)

  sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("Clic Sender"),
    logger: mudo,
    // No bajamos el historial: sólo mandamos. Es lo que más memoria y tiempo
    // costaría al vincular, y no lo usamos para nada.
    syncFullHistory: false,
    // No marcamos el número como "en línea": es un número de la empresa, no
    // queremos que parezca que hay alguien leyendo.
    markOnlineOnConnect: false,
    cachedGroupMetadata: async (jid) => delCache(jid),
  })

  // Se baja acá y no en "open": si el socket nuevo se cierra ANTES de abrir
  // —que es justo lo que pasa con el 515 que WhatsApp manda apenas se vincula—
  // el flag quedaría trabado en true y no habría más reintentos nunca.
  reconectando = false

  sock.ev.on("creds.update", saveCreds)
  sock.ev.on("connection.update", (u) => void alCambiarConexion(u))

  // Los mensajes entrantes siguen sirviendo para descubrir grupos, igual que
  // hoy. Ya no es la vía principal —groupFetchAllParticipating() anda— pero no
  // cuesta nada tenerla de respaldo.
  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const msg of messages ?? []) registrarGrupoDelMensaje(msg)
  })

  sock.ev.on("groups.update", async (eventos) => {
    for (const evento of eventos ?? []) {
      if (!evento?.id) continue
      try {
        cachear(evento.id, await sock.groupMetadata(evento.id))
      } catch { /* se recupera en el próximo listarGrupos */ }
    }
  })
}

/** Los códigos de vinculación vencen al minuto y pico: hay que renovarlos. */
const RENOVAR_CODIGO_MS = 90_000
let timerCodigo = null

function pararRenovacionDelCodigo() {
  if (timerCodigo) {
    clearInterval(timerCodigo)
    timerCodigo = null
  }
}

/**
 * Publica el código de vinculación como imagen.
 *
 * Va por el mismo endpoint que el QR a propósito: así aparece en la pantalla
 * de Clicnet que ya existe (Sedes → Avisos por WhatsApp) sin tocar Clicnet. Un
 * data URL de SVG se renderiza en el mismo `<img>` donde iba el QR.
 */
async function publicarCodigo(codigo) {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">`,
    `<rect width="512" height="512" fill="#ffffff"/>`,
    `<text x="256" y="160" text-anchor="middle" font-family="system-ui,sans-serif" font-size="26" fill="#555555">Código de vinculación</text>`,
    `<text x="256" y="280" text-anchor="middle" font-family="ui-monospace,monospace" font-size="66" font-weight="700" fill="#111111">${codigo}</text>`,
    `<text x="256" y="370" text-anchor="middle" font-family="system-ui,sans-serif" font-size="19" fill="#555555">WhatsApp → Dispositivos vinculados</text>`,
    `<text x="256" y="400" text-anchor="middle" font-family="system-ui,sans-serif" font-size="19" fill="#555555">→ Vincular con número de teléfono</text>`,
    `</svg>`,
  ].join("")
  await publicarQr("data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64"))
}

async function pedirYPublicarCodigo() {
  try {
    const codigo = await sock.requestPairingCode(config.numeroVinculacion)
    console.log(`[whatsapp] código de vinculación: ${codigo}`)
    await publicarCodigo(codigo)
  } catch (error) {
    // Pasa si el socket se cerró en el medio: el socket nuevo lo vuelve a pedir.
    console.error("[whatsapp] no se pudo pedir el código:", error.message)
  }
}

async function alCambiarConexion({ connection, lastDisconnect, qr }) {
  if (qr) {
    conectado = false

    // Con el número configurado vamos por código, que es el camino verificado.
    if (config.numeroVinculacion && !sock?.authState?.creds?.registered) {
      if (!timerCodigo) {
        // El primer QR significa que el canal de registro quedó abierto:
        // recién acá tiene sentido pedir el código.
        await pedirYPublicarCodigo()
        timerCodigo = setInterval(() => void pedirYPublicarCodigo(), RENOVAR_CODIGO_MS)
      }
      return
    }

    console.log("[whatsapp] QR nuevo: hay que vincular el número desde Clicnet")
    try {
      await publicarQr(await QRCode.toDataURL(qr, { width: 512, margin: 1 }))
    } catch (error) {
      console.error("[whatsapp] no se pudo publicar el QR:", error.message)
    }
    return
  }

  if (connection === "open") {
    conectado = true
    reconectando = false
    pararRenovacionDelCodigo()
    numero = sock.user?.id?.split(":")[0]?.split("@")[0] ?? null
    console.log(`[whatsapp] listo, conectado como ${numero}`)
    return
  }

  if (connection !== "close") return

  // El socket viejo ya no sirve para pedir códigos; los pide el que venga.
  pararRenovacionDelCodigo()

  conectado = false
  numero = null
  const codigo = lastDisconnect?.error?.output?.statusCode

  // Sesión cerrada desde el celular: las credenciales ya no sirven. Hay que
  // borrarlas, si no cada reintento falla igual y quedamos en un loop de
  // reinicios (con restartPolicy ALWAYS, para siempre). Borrándolas, el
  // reconnect emite un QR nuevo y alguien lo escanea desde Clicnet.
  if (codigo === DisconnectReason.loggedOut) {
    console.error("[whatsapp] sesión cerrada desde el celular; hace falta escanear el QR de nuevo")
    await fs.rm(authDir(), { recursive: true, force: true }).catch(() => {})
  } else {
    console.error(`[whatsapp] desconectado (${codigo ?? "sin código"}), reconectando`)
  }

  // A diferencia de whatsapp-web.js, acá reconectar en caliente es lo correcto:
  // no hay Chromium que pueda quedar colgado, es un WebSocket. Por eso ya no
  // salimos con exit(1) en cada desconexión — que era, además, lo que gastaba
  // el presupuesto de reinicios de Railway.
  if (reconectando) return
  reconectando = true
  setTimeout(() => {
    conectar().catch((error) => {
      console.error("[whatsapp] no se pudo reconectar:", error.message)
      process.exit(1) // que Railway levante uno limpio
    })
  }, 3_000)
}

/** Manda un mensaje. Tira si falla, para que el loop lo reporte como error. */
export async function mandarMensaje(chatId, texto) {
  if (!sock || !conectado) throw new Error("WhatsApp no está conectado")
  await sock.sendMessage(chatId, { text: texto })
}

function registrarGrupoDelMensaje(msg) {
  try {
    const jid = msg?.key?.remoteJid ?? ""
    if (!jid.endsWith("@g.us")) return

    const previo = grupos.get(jid)
    const cuerpo = (msg?.message?.conversation ?? msg?.message?.extendedTextMessage?.text ?? "")
      .trim().replace(/\s+/g, " ").slice(0, 40)
    const quien = msg?.pushName ?? null
    const pista = cuerpo ? (quien ? `«${cuerpo}» — ${quien}` : `«${cuerpo}»`) : (previo?.pista ?? null)

    grupos.set(jid, { nombre: previo?.nombre ?? null, pista })
  } catch (error) {
    console.error("[whatsapp] no se pudo registrar el grupo:", error.message)
  }
}

/**
 * Grupos donde está el número, para que Clicnet arme el selector de destinos.
 *
 * Con whatsapp-web.js esto dependía de getChats(), que lleva meses roto y
 * dejaba el selector con JIDs crudos. Baileys tiene la API posta, así que acá
 * los nombres vuelven a salir.
 */
export async function listarGrupos() {
  if (!sock || !conectado) return []

  try {
    const todos = await sock.groupFetchAllParticipating()
    for (const [jid, metadata] of Object.entries(todos ?? {})) {
      cachear(jid, metadata)
      const previo = grupos.get(jid)
      grupos.set(jid, { nombre: metadata?.subject ?? previo?.nombre ?? null, pista: previo?.pista ?? null })
    }
  } catch (error) {
    console.error("[whatsapp] groupFetchAllParticipating() falló:", error.message)
  }

  return [...grupos].map(([id, { nombre, pista }]) => ({ id, nombre: nombre ?? id, pista }))
}
