import fs from "node:fs/promises"
import path from "node:path"

/**
 * Mantenimiento del perfil de Chromium, que vive en el volumen (/data).
 *
 * Va aparte de whatsapp.js porque es otra cosa: acá no hay sesión de WhatsApp
 * ni Puppeteer, sólo archivos. Y porque es el código más riesgoso del repo —
 * borra cosas al lado de las credenciales de la sesión — así que conviene que
 * se pueda probar solo, sin levantar un Chromium.
 */

/**
 * Locks que Chromium deja en el perfil.
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
const LOCKS = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket"])

/**
 * Directorios de caché de Chromium, que borramos en cada arranque.
 *
 * Esto es una LISTA BLANCA a propósito, y no "todo menos la sesión": el perfil
 * de Chromium ES el directorio de la sesión (LocalAuth le pasa su carpeta a
 * Puppeteer como userDataDir), así que las credenciales de WhatsApp y la basura
 * conviven en el mismo árbol. Borrar de más significa perder la vinculación y
 * que alguien tenga que ir físicamente con el celular de Clic a escanear el QR.
 *
 * Lo que NO está acá y no puede estarlo: IndexedDB, Local Storage, Session
 * Storage, Cookies, Preferences, Local State y Service Worker — ahí es donde
 * WhatsApp Web guarda la sesión.
 */
const CACHES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "GrShaderCache",
  "component_crx_cache",
  "extensions_crx_cache",
])

/** Bytes que ocupa un directorio, recursivo. Nunca tira: es para un log. */
async function tamañoDe(ruta) {
  let total = 0
  let entradas
  try {
    entradas = await fs.readdir(ruta, { withFileTypes: true })
  } catch {
    return 0
  }

  for (const entrada of entradas) {
    const completo = path.join(ruta, entrada.name)
    if (entrada.isDirectory()) {
      total += await tamañoDe(completo)
    } else {
      try {
        total += (await fs.stat(completo)).size
      } catch { /* se lo llevó alguien en el medio */ }
    }
  }
  return total
}

/**
 * Deja el perfil listo para arrancar: borra los locks viejos y la caché.
 *
 * La caché se limpia porque el volumen venía creciendo sin techo — llegó a 3,8
 * GB con la sesión pesando unos pocos MB. El `--disk-cache-size` que le pasamos
 * a Chromium evita que vuelva a pasar; esto recupera lo ya acumulado.
 *
 * Devuelve los bytes liberados.
 */
export async function prepararPerfil(dir) {
  let liberado = 0
  let entradas
  try {
    entradas = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0 // el perfil todavía no existe: primer arranque
  }

  for (const entrada of entradas) {
    const completo = path.join(dir, entrada.name)

    if (LOCKS.has(entrada.name)) {
      // Son symlinks colgados, por eso `rm` y no `unlink` a secas.
      await fs.rm(completo, { force: true }).catch(() => {})
      console.log(`[perfil] lock viejo borrado: ${completo}`)
    } else if (CACHES.has(entrada.name) && entrada.isDirectory()) {
      liberado += await tamañoDe(completo)
      await fs.rm(completo, { recursive: true, force: true }).catch(() => {})
    } else if (entrada.isDirectory()) {
      liberado += await prepararPerfil(completo)
    }
  }

  return liberado
}
