/**
 * Lectura de los payloads de GitHub relacionados con la instalacion de la App.
 *
 * Este modulo es PURO: no toca la base de datos ni la red. La fila del mapeo
 * instalacion -> tenant vive en `github_installations` y su acceso esta en
 * `packages/db` (`findInstallationRouting`, `upsertInstallation`, ...), porque
 * ese es el paquete que habla con Postgres. Aqui solo se interpreta lo que
 * manda GitHub, que es el trozo que no necesita infraestructura y que por tanto
 * se puede probar sin levantar nada.
 *
 * Todo lo de aqui es frontera de confianza: el payload lo envia GitHub, pero lo
 * recibe un endpoint publico. Se comprueba campo a campo en vez de castear.
 */

export type GithubAccountType = 'Organization' | 'User'
export type RepositorySelection = 'all' | 'selected'

/** Estado de una instalacion tal y como lo describe el payload que la menciona. */
export interface InstallationDescriptor {
  installationId: number
  accountLogin: string
  accountType: GithubAccountType
  repositorySelection: RepositorySelection
  /** `null` si no esta suspendida. */
  suspendedAt: Date | null
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Id de la instalacion que aparece en cualquier evento de una GitHub App.
 * Devuelve `undefined` si el payload no lo trae (por ejemplo, un `ping` de
 * prueba): el llamante decide que hacer, y "no lo trae" no es lo mismo que
 * "es cero".
 */
export function extractInstallationId(payload: unknown): number | undefined {
  const root = asRecord(payload)
  const installation = asRecord(root?.['installation'])
  const id = installation?.['id']
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : undefined
}

/** `action` del payload, o `null` si el evento no la trae (`push` no la trae). */
export function extractAction(payload: unknown): string | null {
  const action = asRecord(payload)?.['action']
  return typeof action === 'string' && action !== '' ? action : null
}

function parseAccountType(value: unknown): GithubAccountType {
  if (value === 'Organization' || value === 'User') {
    return value
  }
  // GitHub tiene tambien cuentas `Bot` y `Enterprise` en algunos payloads. Se
  // rechaza en vez de adivinar: un mapeo mal tipado se descubriria semanas
  // despues y con datos ya escritos.
  throw new Error(`Tipo de cuenta de GitHub no soportado: ${JSON.stringify(value)}`)
}

function parseRepositorySelection(value: unknown): RepositorySelection {
  if (value === 'all' || value === 'selected') {
    return value
  }
  throw new Error(`repository_selection no reconocido: ${JSON.stringify(value)}`)
}

/**
 * Extrae el estado de la instalacion del objeto `installation` del payload.
 * Lanza si falta algo: prefiero que un evento raro haga fallar el job (y quede
 * en la cola de fallidos, visible) a escribir una fila incompleta.
 */
export function parseInstallationDescriptor(payload: unknown): InstallationDescriptor {
  const installation = asRecord(asRecord(payload)?.['installation'])
  if (installation === undefined) {
    throw new Error('El payload no contiene el objeto `installation`.')
  }

  const id = installation['id']
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new Error(`installation.id no es un entero positivo: ${JSON.stringify(id)}`)
  }

  const account = asRecord(installation['account'])
  const login = account?.['login']
  if (typeof login !== 'string' || login === '') {
    throw new Error('installation.account.login ausente o vacio.')
  }

  const suspendedAtRaw = installation['suspended_at']
  let suspendedAt: Date | null = null
  if (typeof suspendedAtRaw === 'string' && suspendedAtRaw !== '') {
    const parsed = new Date(suspendedAtRaw)
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`installation.suspended_at no es una fecha valida: ${suspendedAtRaw}`)
    }
    suspendedAt = parsed
  }

  return {
    installationId: id,
    accountLogin: login,
    accountType: parseAccountType(account?.['type']),
    repositorySelection: parseRepositorySelection(installation['repository_selection']),
    suspendedAt,
  }
}
