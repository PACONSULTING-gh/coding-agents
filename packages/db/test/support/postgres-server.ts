import { randomUUID } from 'node:crypto'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client, type QueryResult } from 'pg'

/**
 * De donde sale el Postgres de los tests de integracion (ADR 0007).
 *
 * ===========================================================================
 * LA POLITICA, Y POR QUE LA TERCERA LINEA ES LA IMPORTANTE
 * ===========================================================================
 *   1. `TEST_DATABASE_URL` definida  -> se usa ese servidor.
 *   2. No definida                   -> un contenedor, UNA VEZ por proceso.
 *   3. No definida Y bajo Stryker    -> FALLA. No mide.
 *
 * Antes cada fichero levantaba su propio contenedor. Para `pnpm test` eso
 * costaba unos segundos; para el mutation testing costaba UN CONTENEDOR POR
 * MUTANTE, y como Stryker cuenta un timeout como mutante muerto, la puntuacion
 * salia de los timeouts y no de los tests: `packages/db/src/client.ts` marcaba
 * 90,34 con CERO mutantes muertos (issue #26).
 *
 * La linea 3 es la que impide que eso vuelva a pasar sin que nadie se entere. Es
 * exactamente la propiedad que hundio a `withReuse()` de testcontainers como
 * alternativa: alli, si faltaba la variable de entorno, se degradaba EN
 * SILENCIO. Aqui, si falta, no hay medicion.
 *
 * Y la linea 2 es la que hace que no haya que pagar nada por la 3: `pnpm test`
 * sigue funcionando sobre un checkout limpio sin arrancar nada.
 */

/** Se levanta un contenedor con esta imagen cuando no hay servidor externo. */
export const POSTGRES_IMAGE = 'postgres:16-alpine'

/** Prefijo de las bases que crea este helper. Sirve tambien para barrer huerfanas. */
export const TEST_DATABASE_PREFIX = 'coordtest_'

export const TEST_DATABASE_URL_ENV = 'TEST_DATABASE_URL'

/**
 * El runner de Vitest de Stryker inyecta un fichero de setup que crea este
 * objeto global en el proceso de test. Es la senal fiable de "esto es una
 * pasada de mutacion", y no una heuristica sobre variables de entorno.
 */
const STRYKER_GLOBAL = '__stryker__'

export type PostgresAcquisition =
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'container' }
  | { readonly kind: 'refuse'; readonly reason: string }

/**
 * La decision, aislada y sin efectos: es lo unico que hay que poder probar sin
 * levantar nada, y es donde esta la regla que impide medir en falso.
 */
export function decidePostgresAcquisition(
  env: Readonly<Record<string, string | undefined>>,
  globals: object,
): PostgresAcquisition {
  const url = env[TEST_DATABASE_URL_ENV]
  if (url !== undefined && url.trim() !== '') {
    return { kind: 'external', url: url.trim() }
  }
  if (STRYKER_GLOBAL in globals) {
    return {
      kind: 'refuse',
      reason:
        `Mutation testing sin ${TEST_DATABASE_URL_ENV}. Levantar un contenedor por mutante hace ` +
        'que la puntuacion salga de los TIMEOUTS y no de los tests: se han medido 90,34 con cero ' +
        'mutantes muertos (issue #26, ADR 0007). Arranca el Postgres del compose y exporta la ' +
        `variable:\n  docker compose -f infra/docker-compose.yml up -d postgres\n  export ` +
        `${TEST_DATABASE_URL_ENV}=postgres://...\nNo hay modo degradado a proposito.`,
    }
  }
  return { kind: 'container' }
}

interface SharedServer {
  /** Conexion con permiso para `CREATE DATABASE`. */
  readonly adminUrl: string
  /** `true` si lo levantamos nosotros: solo entonces tiene sentido pararlo. */
  readonly ownedByUs: boolean
  readonly container?: StartedPostgreSqlContainer
}

let sharedServer: Promise<SharedServer> | undefined

/**
 * El servidor compartido del proceso. Memoizado: bajo `pnpm test` esto convierte
 * "un contenedor por fichero" en "uno por proceso" sin que nadie toque nada.
 */
export function sharedPostgresServer(): Promise<SharedServer> {
  sharedServer ??= startServer()
  return sharedServer
}

async function startServer(): Promise<SharedServer> {
  const decision = decidePostgresAcquisition(process.env, globalThis)
  if (decision.kind === 'refuse') {
    // Ruidoso y sin alternativa: una medicion que no se puede hacer bien no se
    // hace a medias.
    throw new Error(decision.reason)
  }
  if (decision.kind === 'external') {
    return { adminUrl: decision.url, ownedByUs: false }
  }
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start()
  return { adminUrl: container.getConnectionUri(), ownedByUs: true, container }
}

/** Una base de datos aislada dentro del servidor compartido. */
export interface TestDatabase {
  readonly name: string
  readonly url: string
  /** Conexion de superusuario a la base POR DEFECTO, para lo que sea del servidor. */
  readonly adminUrl: string
  sql(text: string, values?: readonly unknown[]): Promise<Record<string, unknown>[]>
  /**
   * La PRIMERA columna de cada fila. Es lo que se quiere el 90% de las veces
   * (`SELECT note FROM ... ORDER BY ...`) y evita que cada test tenga que
   * mapear `(row) => row['note']` a mano.
   */
  sqlColumn(text: string, values?: readonly unknown[]): Promise<unknown[]>
  sqlValue(text: string, values?: readonly unknown[]): Promise<unknown>
  drop(): Promise<void>
}

/**
 * El nombre se interpola en un `CREATE DATABASE`, que no admite parametros. Se
 * construye aqui a partir de un UUID, asi que no viene de fuera — pero la
 * guarda cuesta una linea y convierte "no puede pasar" en "no pasa".
 */
function assertIdentifier(name: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name) || name.length > 63) {
    throw new Error(`Nombre de base de datos no interpolable: ${JSON.stringify(name)}`)
  }
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * Una conexion viva por base de datos, abierta la primera vez que se usa.
 *
 * NO es una optimizacion prematura: con una conexion por CONSULTA la suite de
 * `packages/queue` pasaba de 26 s a 49 s, porque los bucles de espera sondean
 * cada 200 ms y cada sondeo pagaba un handshake completo.
 */
function connectionFor(url: string): () => Promise<Client> {
  let client: Promise<Client> | undefined
  return () => {
    client ??= (async () => {
      const opened = new Client({ connectionString: url })
      await opened.connect()
      return opened
    })()
    return client
  }
}

/**
 * Ejecuta SQL y devuelve TODAS las filas.
 *
 * `pg` devuelve un ARRAY de resultados cuando el texto lleva varias sentencias
 * (protocolo simple, solo sin parametros). Varios tests mandan cuatro `SELECT`
 * de golpe y esperan las cuatro respuestas, asi que aqui se aplanan: quedarse
 * con `result.rows` a secas devolveria `undefined` y el test fallaria por una
 * razon que no tiene nada que ver con lo que prueba.
 */
async function runSql(
  client: Client,
  text: string,
  values?: readonly unknown[],
): Promise<Record<string, unknown>[]> {
  // `pg` tipa `query` como si siempre devolviera UN resultado; con varias
  // sentencias devuelve un array. El tipo de la libreria no lo refleja, asi que
  // se declara aqui lo que de verdad puede volver.
  const raw = (await client.query(text, values === undefined ? undefined : [...values])) as unknown
  const results = (Array.isArray(raw) ? raw : [raw]) as QueryResult<Record<string, unknown>>[]
  return results.flatMap((one) => one.rows ?? [])
}

export async function createTestDatabase(label: string): Promise<TestDatabase> {
  const server = await sharedPostgresServer()
  const name = `${TEST_DATABASE_PREFIX}${label}_${randomUUID().replaceAll('-', '').slice(0, 10)}`
  assertIdentifier(name)

  await withClient(server.adminUrl, (client) => client.query(`CREATE DATABASE ${name}`))

  const url = new URL(server.adminUrl)
  url.pathname = `/${name}`
  const databaseUrl = url.toString()

  const connection = connectionFor(databaseUrl)

  return {
    name,
    url: databaseUrl,
    adminUrl: server.adminUrl,
    sql: async (text, values) => runSql(await connection(), text, values),
    sqlColumn: async (text, values) =>
      (await runSql(await connection(), text, values)).map((row) => Object.values(row).at(0)),
    sqlValue: async (text, values) => {
      const rows = await runSql(await connection(), text, values)
      const row = rows.at(0)
      return row === undefined ? undefined : Object.values(row).at(0)
    },
    drop: async () => {
      await (await connection()).end()
      // `WITH (FORCE)` porque pg-boss deja conexiones vivas: sin eso el DROP se
      // queda esperando y el test siguiente hereda la base.
      await withClient(server.adminUrl, (client) =>
        client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
      )
    },
  }
}

/**
 * Borra las bases que dejo una ejecucion anterior que murio sin limpiar.
 *
 * Confiar en el `afterAll` no basta: un test que revienta el proceso no lo
 * ejecuta, y sobre un servidor externo esas bases se quedan para siempre.
 */
export async function sweepOrphanTestDatabases(): Promise<number> {
  const server = await sharedPostgresServer()
  if (server.ownedByUs) return 0
  return withClient(server.adminUrl, async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname LIKE $1',
      [`${TEST_DATABASE_PREFIX}%`],
    )
    for (const row of rows) {
      assertIdentifier(row.datname)
      await client.query(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`)
    }
    return rows.length
  })
}
