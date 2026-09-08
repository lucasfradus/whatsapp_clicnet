import fs from "node:fs/promises"
import path from "node:path"
import zlib from "node:zlib"
import { config } from "./config.js"

/**
 * Siembra del auth state desde `BAILEYS_AUTH_SEED`.
 *
 * Va aparte de whatsapp.js por lo mismo que en su momento fue perfil.js: es
 * código que escribe y borra al lado de las credenciales de la sesión, y así
 * se puede probar entero sin abrir un socket contra WhatsApp — que además no
 * se puede hacer impunemente, porque dos procesos con las mismas credenciales
 * se pisan y desloguean el número.
 */

/**
 * ¿El volumen tiene una sesión REALMENTE vinculada?
 *
 * No alcanza con que exista `creds.json`: Baileys lo escribe apenas arranca,
 * antes de que nadie vincule nada. Lo que distingue una sesión de verdad es
 * `me.id`, que sólo aparece después de un pairing exitoso.
 *
 * Esta distinción no es teórica: el primer deploy con semilla se salvó de
 * casualidad. El `creds.json` a medias estaba ahí y habría bloqueado la
 * siembra; lo que la destrabó fue que WhatsApp respondiera `loggedOut` y el
 * manejador de esa rama borrara el directorio justo antes.
 */
export async function haySesionVinculada(dir) {
  try {
    const creds = JSON.parse(await fs.readFile(path.join(dir, "creds.json"), "utf8"))
    return Boolean(creds?.me?.id)
  } catch {
    return false
  }
}

/**
 * Escribe en el volumen un auth state ya vinculado, si no hay ninguno.
 *
 * Ver el comentario de `authSeed` en config.js para el porqué. Lo importante
 * acá: **no pisa una sesión vinculada**. Dejar la variable puesta por olvido
 * no puede romper una sesión que está andando.
 *
 * Devuelve cuántos archivos escribió (0 si no hizo nada).
 */
export async function sembrarAuthState(dir) {
  if (!config.authSeed) return 0
  if (await haySesionVinculada(dir)) return 0

  try {
    const json = zlib.gunzipSync(Buffer.from(config.authSeed, "base64")).toString("utf8")
    const archivos = JSON.parse(json)

    // Barrer lo que hubiera antes. Llegamos acá sólo si NO hay sesión
    // vinculada, así que no se pierde nada — y dejar mezclados los restos de
    // un intento a medias con las claves de la semilla es pedir problemas.
    for (const viejo of await fs.readdir(dir).catch(() => [])) {
      await fs.rm(path.join(dir, viejo), { recursive: true, force: true }).catch(() => {})
    }

    let escritos = 0
    for (const [nombre, contenido] of Object.entries(archivos)) {
      // El nombre viene de una variable de entorno: que no se pueda escribir
      // fuera del directorio de la sesión.
      if (nombre.includes("/") || nombre.includes("\\") || nombre.startsWith(".")) continue
      await fs.writeFile(path.join(dir, nombre), contenido, "utf8")
      escritos++
    }
    console.log(`[whatsapp] auth state sembrado desde BAILEYS_AUTH_SEED (${escritos} archivos)`)
    return escritos
  } catch (error) {
    console.error("[whatsapp] no se pudo sembrar el auth state:", error.message)
    return 0
  }
}
