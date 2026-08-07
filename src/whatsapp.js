import fs from "node:fs/promises"
import path from "node:path"
import pkg from "whatsapp-web.js"
import QRCode from "qrcode"
import { config } from "./config.js"
import { publicarQr } from "./clicnet.js"

const { Client, LocalAuth } = pkg

/**
 * Sesión de WhatsApp Web.
 *
 * Es UNA sola para toda la cadena: el número de Clic está en los grupos de las
 * 14 sedes. La sesión vive en `dataPath`, que en Railway tiene que ser un
 * volumen — sin eso, cada deploy pide QR de nuevo.
 *
 * El servicio corre con UNA réplica. La sesión es un lock de archivo: dos
 * instancias apuntando al mismo volumen se pisan y desloguean el número.
 */

let cliente = null
let conectado = false
let numero = null

export function estaConectado() {
  return conectado
}

export function numeroConectado() {
  return numero
}

/**
 * Borra los locks que Chromium deja en el perfil.
 *
 * El perfil vive en el volumen, así que el `SingletonLock` del contenedor
 * anterior sobrevive al reinicio. Chromium lo ve, cree que hay otra instancia
 * usando el perfil ("appears to be in use by another Chromium process ... on
 * another computer") y se niega a arrancar — el servicio queda muerto para
 * siempre después del primer redeploy.
 *
 * Como corremos con UNA sola réplica, un lock encontrado al arrancar es siempre
 * de un contenedor que ya no existe. Se puede borrar sin miedo.
 */
async function limpiarLocksDeChromium(dir) {
  const LOCKS = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket"])
  let entradas
  try {
    entradas = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return // el perfil todavía no existe: primer arranque
  }

  for (const entrada of entradas) {
    const completo = path.join(dir, entrada.name)
    if (LOCKS.has(entrada.name)) {
      // Son symlinks colgados, por eso `rm` y no `unlink` a secas.
      await fs.rm(completo, { force: true }).catch(() => {})
      console.log(`[whatsapp] lock viejo borrado: ${completo}`)
    } else if (entrada.isDirectory()) {
      await limpiarLocksDeChromium(completo)
    }
  }
}

export async function iniciarWhatsapp() {
  await limpiarLocksDeChromium(config.dataPath)

  cliente = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(config.dataPath, "sesion") }),
    puppeteer: {
      headless: true,
      // Chromium del sistema (lo instala el Dockerfile), no el que baja Puppeteer.
      executablePath: process.env.CHROME_BIN || "/usr/bin/chromium",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        // El /dev/shm de un contenedor es chico y Chromium se cae solo sin esto.
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  })

  cliente.on("qr", async (qr) => {
    conectado = false
    console.log("[whatsapp] QR nuevo: hay que vincular el número desde Clicnet")
    try {
      const dataUrl = await QRCode.toDataURL(qr, { width: 512, margin: 1 })
      await publicarQr(dataUrl)
    } catch (error) {
      console.error("[whatsapp] no se pudo publicar el QR:", error.message)
    }
  })

  cliente.on("ready", () => {
    conectado = true
    numero = cliente.info?.wid?.user ?? null
    console.log(`[whatsapp] listo, conectado como ${numero}`)
  })

  cliente.on("authenticated", () => {
    console.log("[whatsapp] sesión autenticada")
  })

  cliente.on("auth_failure", (mensaje) => {
    conectado = false
    console.error("[whatsapp] falló la autenticación:", mensaje)
  })

  cliente.on("disconnected", (motivo) => {
    conectado = false
    numero = null
    console.error("[whatsapp] desconectado:", motivo)
    // No reconectamos a mano: salimos y que Railway reinicie el contenedor.
    // Reconectar en caliente con whatsapp-web.js deja el Chromium colgado.
    process.exit(1)
  })

  await cliente.initialize()
}

/** Manda un mensaje. Tira si falla, para que el loop lo reporte como error. */
export async function mandarMensaje(chatId, texto) {
  if (!cliente || !conectado) throw new Error("WhatsApp no está conectado")
  await cliente.sendMessage(chatId, texto)
}

/**
 * Grupos donde está el número, para que Clicnet arme el selector de destinos.
 * Devuelve [] si todavía no cargó: no es un error, es que recién arranca.
 */
export async function listarGrupos() {
  if (!cliente || !conectado) return []
  try {
    const chats = await cliente.getChats()
    return chats
      .filter((c) => c.isGroup)
      .map((c) => ({ id: c.id._serialized, nombre: c.name ?? "(sin nombre)" }))
  } catch (error) {
    console.error("[whatsapp] no se pudieron listar los grupos:", error.message)
    return []
  }
}
