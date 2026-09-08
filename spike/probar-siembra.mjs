/**
 * Prueba la siembra del auth state. NO se conecta a WhatsApp: sólo ejercita la
 * decisión de sembrar o no, que es donde estuvo el bug.
 *
 *   node spike/probar-siembra.mjs
 *
 * Que no se conecte es a propósito: producción está usando esas credenciales, y
 * dos procesos con las mismas claves se pisan y desloguean el número.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"

// Una semilla de mentira, con la forma real: {archivo: contenido}
const SEMILLA = {
  "creds.json": JSON.stringify({ me: { id: "5491100000000:9@s.whatsapp.net" }, noise: "x" }),
  "app-state-sync-key-AAAAAA01.json": JSON.stringify({ k: 1 }),
  "session-5491100000000.0.json": JSON.stringify({ s: 1 }),
  "../fuera.json": JSON.stringify({ maligno: true }),          // no se debe escribir
  "sub/dir.json": JSON.stringify({ maligno: true }),           // no se debe escribir
  ".oculto": "x",                                              // no se debe escribir
}
process.env.BAILEYS_AUTH_SEED = zlib
  .gzipSync(Buffer.from(JSON.stringify(SEMILLA), "utf8"), { level: 9 })
  .toString("base64")
process.env.CLICNET_URL = "http://127.0.0.1:9"
process.env.SENDER_TOKEN = "spike"

const { sembrarAuthState, haySesionVinculada } = await import("../src/auth-seed.js")

let fallos = 0
const chequear = (ok, texto) => {
  console.log(`  ${ok ? "OK   " : "FALLA"} ${texto}`)
  if (!ok) fallos++
}

async function carpeta(contenido = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "seed-"))
  for (const [n, c] of Object.entries(contenido)) await fs.writeFile(path.join(dir, n), c, "utf8")
  return dir
}

console.log("\n=== 1. volumen vacio ===")
{
  const dir = await carpeta()
  const escritos = await sembrarAuthState(dir)
  const hay = await fs.readdir(dir)
  chequear(escritos === 3, `sembro los 3 archivos legitimos (escribio ${escritos})`)
  chequear(hay.includes("creds.json"), "escribio creds.json")
  chequear(!hay.some((f) => f.includes("fuera") || f.includes("oculto")), "filtro los nombres con ruta y ocultos")
  chequear(!(await fs.readdir(path.dirname(dir))).includes("fuera.json"), "NO escribio fuera del directorio")
  await fs.rm(dir, { recursive: true, force: true })
}

console.log("\n=== 2. creds.json a medias (sin me.id) — el caso que estaba roto ===")
{
  const dir = await carpeta({
    "creds.json": JSON.stringify({ noise: "sin vincular" }),
    "basura-vieja.json": "{}",
  })
  chequear((await haySesionVinculada(dir)) === false, "no lo toma como sesion vinculada")
  const escritos = await sembrarAuthState(dir)
  const hay = await fs.readdir(dir)
  chequear(escritos === 3, `sembro igual (escribio ${escritos})`)
  chequear(!hay.includes("basura-vieja.json"), "barrio los restos del intento anterior")
  const creds = JSON.parse(await fs.readFile(path.join(dir, "creds.json"), "utf8"))
  chequear(Boolean(creds?.me?.id), "creds.json quedo con la sesion de la semilla")
  await fs.rm(dir, { recursive: true, force: true })
}

console.log("\n=== 3. sesion vinculada de verdad — NO se toca ===")
{
  const propia = JSON.stringify({ me: { id: "5491199999999:22@s.whatsapp.net" }, noise: "la buena" })
  const dir = await carpeta({ "creds.json": propia, "clave-propia.json": "{}" })
  chequear((await haySesionVinculada(dir)) === true, "la reconoce como vinculada")
  const escritos = await sembrarAuthState(dir)
  chequear(escritos === 0, `no escribio nada (escribio ${escritos})`)
  chequear((await fs.readFile(path.join(dir, "creds.json"), "utf8")) === propia, "dejo intacto el creds.json existente")
  chequear((await fs.readdir(dir)).includes("clave-propia.json"), "no borro las claves de esa sesion")
  await fs.rm(dir, { recursive: true, force: true })
}

console.log("\n=== 4. sin variable, no hace nada ===")
{
  // En proceso aparte: config.js lee el entorno UNA vez al importarse, así que
  // borrar la variable acá no alcanzaría — quedaría cacheada y el test mentiría.
  const dir = await carpeta()
  const guion = `
    import { sembrarAuthState } from ${JSON.stringify(new URL("../src/auth-seed.js", import.meta.url).href)}
    console.log(await sembrarAuthState(${JSON.stringify(dir)}))
  `
  const { execFileSync } = await import("node:child_process")
  const entorno = { ...process.env, CLICNET_URL: "http://127.0.0.1:9", SENDER_TOKEN: "spike" }
  delete entorno.BAILEYS_AUTH_SEED
  const salida = execFileSync(process.execPath, ["--input-type=module", "-e", guion], {
    env: entorno,
    encoding: "utf8",
  }).trim()
  chequear(salida === "0", `sin BAILEYS_AUTH_SEED no escribe (devolvio ${salida})`)
  chequear((await fs.readdir(dir)).length === 0, "el directorio quedo vacio")
  await fs.rm(dir, { recursive: true, force: true })
}

console.log(fallos === 0 ? "\n>>> TODO OK\n" : `\n>>> ${fallos} FALLO(S)\n`)
process.exit(fallos === 0 ? 0 : 1)
