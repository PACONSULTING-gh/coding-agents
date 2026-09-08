import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Lee el entorno del servicio `pgbouncer` de `infra/docker-compose.yml`.
 *
 * POR QUE ESTO EXISTE. El test de PgBouncer montaba su propio pooler con la
 * configuracion escrita a mano en el propio test, asi que verificaba el
 * criterio de aceptacion sobre una COPIA, no sobre lo que se despliega. Las dos
 * configuraciones ya habian divergido (`MIN_POOL_SIZE` y `RESERVE_POOL_SIZE`
 * existian en el compose y no en el test), y si alguien cambiase `POOL_MODE` a
 * `session` -el fallo de aislamiento contra el que avisa toda la cabecera de
 * `src/client.ts`- el test habria seguido en verde.
 *
 * NO es un parser de YAML: es un lector deliberadamente estrecho del bloque
 * `environment` de UN servicio, con entradas escalares `CLAVE: valor`. Si el
 * fichero deja de tener esa forma, falla en voz alta en vez de devolver un
 * entorno a medias (peldano 7 de la escalera: el minimo que funciona, sin
 * anadir una dependencia de YAML al stack aprobado).
 *
 * Las entradas que no son escalares en una linea -hoy solo `DATABASE_URL`, que
 * es un bloque plegado con interpolacion `${...}`- se omiten a proposito: el
 * test tiene que apuntar a SU Postgres, no al del compose.
 */
export interface ComposeEnvironment {
  readonly values: Readonly<Record<string, string>>
  /** Ruta del fichero leido, para los mensajes de error. */
  readonly file: string
}

/** packages/db/test/support -> raiz del monorepo. */
function repositoryRoot(): string {
  return dirname(dirname(dirname(dirname(import.meta.dirname))))
}

export const COMPOSE_FILE = join(repositoryRoot(), 'infra', 'docker-compose.yml')

export async function readServiceEnvironment(service: string): Promise<ComposeEnvironment> {
  const content = await readFile(COMPOSE_FILE, 'utf8')
  const lines = content.split('\n')

  const serviceIndex = lines.findIndex((line) => line === `  ${service}:`)
  if (serviceIndex === -1) {
    throw new Error(`No existe el servicio "${service}" en ${COMPOSE_FILE}.`)
  }

  const envIndex = lines.findIndex(
    (line, index) => index > serviceIndex && line === '    environment:',
  )
  if (envIndex === -1) {
    throw new Error(`El servicio "${service}" de ${COMPOSE_FILE} no declara environment.`)
  }

  const values: Record<string, string> = {}
  for (let i = envIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    // Fin del bloque: cualquier linea con indentacion de 4 o menos.
    if (!line.startsWith('      ')) break

    const match = /^ {6}([A-Za-z_][A-Za-z0-9_]*): (.*)$/.exec(line)
    if (match === null) continue
    const [, key, rawValue] = match
    if (key === undefined || rawValue === undefined) continue
    // Bloques plegados (`>-`, `|`) y valores con interpolacion: los omite el
    // llamante a proposito (ver cabecera).
    if (rawValue.startsWith('>') || rawValue.startsWith('|') || rawValue.includes('${')) continue
    values[key] = rawValue.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')
  }

  if (Object.keys(values).length === 0) {
    throw new Error(
      `No se leyo ni una variable del servicio "${service}" en ${COMPOSE_FILE}: el lector esta roto.`,
    )
  }
  return { values, file: COMPOSE_FILE }
}
