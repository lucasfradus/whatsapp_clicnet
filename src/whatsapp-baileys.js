import fs from "node:fs/promises"
import path from "node:path"
import QRCode from "qrcode"
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} from "baileys"
import { config } from "./config.js"
import { publicarQr } from "./clicnet.js"

/**
 * Sesión de WhatsApp con Baileys (SPIKE — todavía no es lo que corre).
 *
 * Expone exactamente la misma interfaz que whatsapp.js, así que index.js y
 * clicnet.js no cambian: iniciarWhatsapp, mandarMensaje, listarGrupos,
 * estaConectado, numeroConectado.
 *
 * La diferencia con whatsapp-web.js es que acá NO hay navegador: Baileys habla
 * el protocolo multi-device de WhatsApp directo por WebSocket. Eso se lleva
 * puesto, de una, los tres problemas del servicio actual:
 *
 *  - la fuga de memoria (medido: ~100 MB contra 836 MB de piso de Chromium);
 *  - el volumen de 3,3 GB (el auth state son unos JSON de pocos KB), y con él
 *    toda la familia de bugs del SingletonLock;
 *  - getChats(), que estaba roto hace meses: acá los grupos salen de
 *    groupFetchAllParticipating(), que es una API de verdad.
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

async function conectar() {
  const dir = authDir()
  await fs.mkdir(dir, { recursive: true })
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

async function alCambiarConexion({ connection, lastDisconnect, qr }) {
  if (qr) {
    conectado = false
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
    numero = sock.user?.id?.split(":")[0]?.split("@")[0] ?? null
    console.log(`[whatsapp] listo, conectado como ${numero}`)
    return
  }

  if (connection !== "close") return

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
