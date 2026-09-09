import { App } from '@octokit/app'
import { Octokit } from 'octokit'

/**
 * Construccion del cliente de la GitHub App.
 *
 * Decision ya tomada (CLAUDE.md 3): GitHub App, no OAuth App. La App tiene
 * identidad propia, sobrevive a que se vaya quien la instalo, y sus tokens de
 * instalacion duran una hora y tienen permisos finos.
 *
 * SECRETOS: ni la clave privada ni el secreto de webhook aparecen jamas en el
 * repositorio, ni en tests, ni en fixtures (CLAUDE.md 5). Entran por variables
 * de entorno; los tests generan un par RSA al vuelo en memoria. Nada de este
 * modulo escribe en el log: si algo falla, el mensaje del error habla del
 * NOMBRE de la variable que falta, nunca de su contenido.
 */

export interface GitHubAppConfig {
  /** Id numerico de la App (pagina de configuracion de la App en GitHub). */
  appId: number
  /** Clave privada en PEM, ya decodificada. */
  privateKey: string
  /** Secreto compartido con el que GitHub firma los webhooks. */
  webhookSecret: string
  /** Solo para tests: apunta el cliente a un servidor local en vez de a api.github.com. */
  baseUrl?: string
}

/** Nombres de las variables de entorno. Aqui, una sola vez, para que no se dupliquen. */
export const ENV_APP_ID = 'GITHUB_APP_ID'
export const ENV_PRIVATE_KEY = 'GITHUB_APP_PRIVATE_KEY'
export const ENV_WEBHOOK_SECRET = 'GITHUB_WEBHOOK_SECRET'

const PEM_HEADER = /-----BEGIN (RSA )?PRIVATE KEY-----/

/**
 * Decodifica la clave privada, que viaja en base64 EN UNA SOLA LINEA.
 *
 * Va en base64 porque un PEM tiene saltos de linea y meterlo tal cual en un
 * `.env`, en un secreto de CI o en una variable de un contenedor lo parte por
 * la mitad de formas distintas segun la plataforma. Una linea es una linea en
 * todas ellas.
 *
 * Se acepta tambien un PEM ya en claro: si alguien pega la clave sin
 * codificar, es mejor que funcione a que arranque con una clave corrupta.
 * Lo que NO se acepta es algo que no sea ninguna de las dos cosas.
 */
export function decodePrivateKey(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new Error(`${ENV_PRIVATE_KEY} esta vacia.`)
  }
  if (PEM_HEADER.test(trimmed)) {
    return trimmed
  }

  const decoded = Buffer.from(trimmed, 'base64').toString('utf8')
  if (!PEM_HEADER.test(decoded)) {
    // El mensaje describe el FORMATO esperado y no incluye el valor recibido:
    // volcar una clave privada mal codificada en un log sigue siendo volcar una
    // clave privada.
    throw new Error(
      `${ENV_PRIVATE_KEY} no contiene una clave privada PEM. Se espera el fichero .pem ` +
        'de la GitHub App codificado en base64 en una sola linea ' +
        '(base64 -w0 clave-privada.pem). Ver docs/github-app-setup.md.',
    )
  }
  return decoded
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Falta la variable de entorno ${name}. Ver .env.example y docs/github-app-setup.md.`,
    )
  }
  return value
}

/**
 * Lee la configuracion del entorno. Falla ruidosamente y de una vez, en el
 * arranque: un proceso a medio configurar que descubre el problema con el
 * primer webhook es un proceso que ya ha perdido eventos.
 */
export function githubAppConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig {
  const rawAppId = requireEnv(env, ENV_APP_ID)
  const appId = Number(rawAppId)
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new Error(`${ENV_APP_ID} debe ser un entero positivo. Recibido: ${rawAppId}`)
  }

  return {
    appId,
    privateKey: decodePrivateKey(requireEnv(env, ENV_PRIVATE_KEY)),
    webhookSecret: requireEnv(env, ENV_WEBHOOK_SECRET),
  }
}

/**
 * Cliente de la GitHub App. De aqui salen el octokit autenticado como App
 * (JWT, para operaciones de la propia App) y `getInstallationOctokit()`.
 *
 * No se pasan las credenciales de OAuth: este servicio no actua nunca en
 * nombre de un usuario. El dia que haga falta (login con GitHub), se anaden
 * aqui y no en otro sitio.
 *
 * SIEMPRE se pasa `Octokit` (el de el paquete `octokit`, con `.rest.*` y el
 * resto de plugins), y no solo cuando hay `baseUrl` de test. `@octokit/app`
 * usa `@octokit/core` PELADO como valor por defecto cuando no se le da un
 * `Octokit` — sin `.rest` — y hasta T05 (epic 05) nada de este repositorio
 * necesitaba `.rest.*`, asi que el hueco no se habia notado: el cliente de
 * produccion (sin `baseUrl`) se estaba quedando SIN los metodos REST. Se
 * detecto al escribir `pull-request-comments.ts`, que si los necesita, y es un
 * fallo real de produccion, no solo de tipos: se corrige aqui para todo el
 * mundo, no con un cast local en el llamante.
 */
export function createGitHubApp(config: GitHubAppConfig): App<{ Octokit: typeof Octokit }> {
  return new App({
    appId: config.appId,
    privateKey: config.privateKey,
    webhooks: { secret: config.webhookSecret },
    // `baseUrl` solo se usa en tests, contra un servidor HTTP local que hace de
    // doble de la API de GitHub. En produccion se omite y vale api.github.com.
    Octokit: config.baseUrl === undefined ? Octokit : Octokit.defaults({ baseUrl: config.baseUrl }),
  })
}
