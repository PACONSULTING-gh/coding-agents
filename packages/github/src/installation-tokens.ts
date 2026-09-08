import type { App } from '@octokit/app'

/**
 * Tokens de instalacion de la GitHub App.
 *
 * Un token de instalacion dura UNA HORA. Pedir uno nuevo en cada llamada
 * gastaria un viaje a GitHub (y una firma JWT) por peticion; reutilizarlo hasta
 * el ultimo segundo garantiza que tarde o temprano caduque justo en medio de
 * una llamada larga. Esta cache resuelve las dos cosas: sirve el token cacheado
 * mientras le queden mas de `renewMarginMs` de vida, y lo renueva de forma
 * transparente cuando entra en ese margen.
 *
 * ---------------------------------------------------------------------------
 * POR QUE UNA CACHE PROPIA HABIENDO UNA EN @octokit/auth-app
 * ---------------------------------------------------------------------------
 * `@octokit/auth-app` cachea internamente, pero con dos decisiones que no nos
 * sirven (se ha leido su codigo antes de escribir esto):
 *
 *   - Su TTL es de 59 minutos contados desde que GUARDA el token, no desde el
 *     `expires_at` que devuelve GitHub. El margen efectivo es de un minuto y
 *     depende de que el reloj local y el de GitHub coincidan. Un minuto es
 *     "justo al filo": un job que tarde mas de eso empieza con token valido y
 *     termina con 401.
 *   - Ese margen no es configurable.
 *
 * Asi que la politica de caducidad la lleva esta clase, sobre el `expires_at`
 * REAL de GitHub, y a `auth-app` se le pide siempre `refresh: true` para que no
 * conteste desde su propia cache y devuelva un token de verdad nuevo. Cada
 * capa hace una cosa: `auth-app` firma el JWT y habla con la API, esto decide
 * cuando toca renovar.
 *
 * NADA de este modulo escribe en el log. Un token de instalacion es una
 * credencial con permisos de escritura sobre los repositorios del cliente: en
 * cuanto aparece en un log, aparece en el sistema de logs, en las copias de
 * seguridad de ese sistema y en la pantalla de quien lo abra.
 */

/** Cinco minutos: mas que cualquier operacion de un handler razonable. */
export const DEFAULT_RENEW_MARGIN_MS = 5 * 60 * 1000

export interface InstallationToken {
  token: string
  expiresAt: Date
}

/** Lo que hay que saber hacer para conseguir un token nuevo. Inyectable para poder probarlo. */
export type InstallationTokenFetcher = (installationId: number) => Promise<InstallationToken>

export interface InstallationTokenCacheOptions {
  fetch: InstallationTokenFetcher
  /** Cuanta vida le tiene que quedar a un token para seguir sirviendolo. */
  renewMarginMs?: number
  /** Reloj inyectable, en milisegundos. Existe para los tests; en produccion es `Date.now`. */
  now?: () => number
}

interface CacheEntry {
  /** Ultimo token conocido. Ausente mientras se pide el primero. */
  token?: InstallationToken
  /** Renovacion en vuelo. Mientras exista, las llamadas nuevas se enganchan a ella. */
  refreshing?: Promise<InstallationToken>
}

export class InstallationTokenCache {
  readonly #fetch: InstallationTokenFetcher
  readonly #renewMarginMs: number
  readonly #now: () => number
  readonly #entries = new Map<number, CacheEntry>()

  constructor(options: InstallationTokenCacheOptions) {
    this.#fetch = options.fetch
    this.#renewMarginMs = options.renewMarginMs ?? DEFAULT_RENEW_MARGIN_MS
    this.#now = options.now ?? Date.now
  }

  /**
   * Token valido para `installationId`, del cache o recien pedido.
   *
   * Dos llamadas concurrentes con el token caducado provocan UNA sola peticion
   * a GitHub: la primera deja la promesa en `refreshing` y la segunda se
   * engancha a ella. Sin esto, un pico de trabajo tras un despliegue dispara
   * tantas peticiones de token como jobs en vuelo, y GitHub responde con
   * limite de tasa justo cuando peor viene.
   */
  async getToken(installationId: number): Promise<InstallationToken> {
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new Error(
        `installationId invalido: ${String(installationId)}. Debe ser un entero positivo.`,
      )
    }

    const entry = this.#entries.get(installationId)
    if (entry?.token !== undefined && this.#isFresh(entry.token)) {
      return entry.token
    }
    // Ya hay una renovacion en vuelo: engancharse a ella en vez de lanzar otra.
    // Aqui es donde dos llamadas concurrentes se convierten en UNA peticion.
    if (entry?.refreshing !== undefined) {
      return entry.refreshing
    }

    const refreshing = this.#refresh(installationId)
    // Se conserva el token viejo mientras llega el nuevo: si la renovacion
    // falla, no se pierde informacion util para diagnosticar.
    this.#entries.set(
      installationId,
      entry?.token === undefined ? { refreshing } : { token: entry.token, refreshing },
    )
    return refreshing
  }

  /**
   * Olvida el token de una instalacion. Se usa cuando GitHub responde 401 pese
   * a que el token parecia fresco (revocacion, suspension de la instalacion):
   * el siguiente `getToken` pide uno nuevo en vez de repetir el fallo.
   */
  invalidate(installationId: number): void {
    this.#entries.delete(installationId)
  }

  /** Numero de instalaciones con entrada en cache. Para metricas y tests. */
  get size(): number {
    return this.#entries.size
  }

  #isFresh(token: InstallationToken): boolean {
    return token.expiresAt.getTime() - this.#now() > this.#renewMarginMs
  }

  async #refresh(installationId: number): Promise<InstallationToken> {
    try {
      const token = await this.#fetch(installationId)
      if (token.token === '' || Number.isNaN(token.expiresAt.getTime())) {
        throw new Error(
          `El proveedor de tokens devolvio un token inutilizable para la instalacion ` +
            `${String(installationId)} (token vacio o fecha de caducidad invalida).`,
        )
      }
      this.#entries.set(installationId, { token })
      return token
    } catch (error) {
      // La entrada se limpia para que el siguiente intento vuelva a pedirlo, y
      // el error se propaga entero: quien llamo tiene que enterarse de que no
      // hay token (CLAUDE.md 5, nada de catch silencioso).
      this.#entries.delete(installationId)
      throw error
    }
  }
}

/**
 * Forma del objeto que devuelve `octokit.auth({type: 'installation'})`. Viene
 * de una libreria y, detras de ella, de la API de GitHub: se valida antes de
 * usarlo en vez de castearlo y confiar.
 *
 * La validacion es a mano y no con zod porque `zod` no es dependencia de este
 * paquete y el contrato son dos campos (escalera de pereza, CLAUDE.md 2.4).
 */
function parseAuthentication(raw: unknown, installationId: number): InstallationToken {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(
      `Respuesta de autenticacion inesperada para la instalacion ${String(installationId)}.`,
    )
  }
  const candidate = raw as { token?: unknown; expiresAt?: unknown }
  if (typeof candidate.token !== 'string' || candidate.token === '') {
    throw new Error(
      `La autenticacion de la instalacion ${String(installationId)} no devolvio token.`,
    )
  }
  if (typeof candidate.expiresAt !== 'string') {
    throw new Error(
      `La autenticacion de la instalacion ${String(installationId)} no devolvio expiresAt.`,
    )
  }
  const expiresAt = new Date(candidate.expiresAt)
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error(
      `expiresAt no es una fecha valida para la instalacion ${String(installationId)}.`,
    )
  }
  return { token: candidate.token, expiresAt }
}

/**
 * Proveedor de tokens respaldado por la GitHub App.
 *
 * `refresh: true` es deliberado: desactiva la cache interna de
 * `@octokit/auth-app` para que la unica politica de caducidad sea la de
 * `InstallationTokenCache` (ver la cabecera del modulo). Como esta funcion solo
 * se invoca cuando la cache decide renovar, no supone peticiones de mas.
 */
export function installationTokenFetcher(app: App): InstallationTokenFetcher {
  return async (installationId) => {
    const raw = await app.octokit.auth({ type: 'installation', installationId, refresh: true })
    return parseAuthentication(raw, installationId)
  }
}
