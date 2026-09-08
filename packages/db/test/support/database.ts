import { randomBytes } from 'node:crypto'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import type { StartedNetwork } from 'testcontainers'

import { migrate } from '../../src/migrate.js'

/**
 * Montaje compartido por los tests de integracion: un PostgreSQL DE VERDAD con
 * la MISMA separacion de roles que el despliegue real. Nada mockeado
 * (CLAUDE.md 5): lo que se comprueba es el comportamiento del motor.
 *
 *   1. El superusuario del contenedor aplica solo la migracion 0001, que crea
 *      `app_migrator` y `app_runtime`.
 *   2. Se les asigna contrasena fuera de banda. Aqui es aleatoria por
 *      ejecucion; en produccion viene de variables de entorno. En el
 *      repositorio no hay ninguna contrasena, ni siquiera de test
 *      (CLAUDE.md 5).
 *   3. El resto de migraciones las aplica `app_migrator`, que queda como DUENO
 *      de las tablas. Sin eso, `FORCE ROW LEVEL SECURITY` no se estaria
 *      ejercitando y media suite pasaria por casualidad.
 */

export const POSTGRES_IMAGE = 'postgres:16-alpine'

export interface StartedDatabase {
  container: StartedPostgreSqlContainer
  /** Conexion del rol de la aplicacion. Es la que usa la capa de acceso. */
  runtimeUrl: string
  /** Conexion del rol de migraciones (dueno del esquema). */
  migratorUrl: string
  /** Conexion privilegiada, solo para inspeccionar el catalogo desde los tests. */
  superUrl: string
  runtimeUser: string
  runtimePassword: string
  database: string
  /** Puerto de Postgres DENTRO de la red de Docker (5432), no el publicado. */
  internalPort: number
}

/**
 * Contrasena aleatoria por ejecucion, hexadecimal. Hexadecimal a proposito:
 * `ALTER ROLE ... PASSWORD` no admite parametros y hay que interpolar, asi que
 * el conjunto de caracteres se restringe a uno que no puede escapar de la
 * cadena literal.
 */
function generatePassword(): string {
  return randomBytes(24).toString('hex')
}

function assertHex(password: string): void {
  if (!/^[0-9a-f]+$/.test(password)) {
    throw new Error('La contrasena generada debe ser hexadecimal para poder interpolarse en SQL.')
  }
}

function connectionUrl(
  started: StartedPostgreSqlContainer,
  user: string,
  password: string,
): string {
  assertHex(password)
  const host = started.getHost()
  const port = String(started.getPort())
  return `postgres://${user}:${password}@${host}:${port}/${started.getDatabase()}`
}

export interface StartDatabaseOptions {
  /** Red de Docker a la que unir el contenedor (para poner PgBouncer delante). */
  network?: StartedNetwork
  /** Alias con el que otros contenedores de esa red resuelven a Postgres. */
  networkAlias?: string
}

export async function startDatabase(options: StartDatabaseOptions = {}): Promise<StartedDatabase> {
  let builder = new PostgreSqlContainer(POSTGRES_IMAGE)
  if (options.network !== undefined) {
    builder = builder.withNetwork(options.network)
  }
  if (options.networkAlias !== undefined) {
    builder = builder.withNetworkAliases(options.networkAlias)
  }
  const container = await builder.start()

  const migratorPassword = generatePassword()
  const runtimePassword = generatePassword()
  assertHex(migratorPassword)
  assertHex(runtimePassword)

  const superUrl = container.getConnectionUri()

  // Paso 1: bootstrap de roles con el rol privilegiado.
  const bootstrapped = await migrate({ databaseUrl: superUrl, direction: 'up', count: 1 })
  if (bootstrapped[0] !== '0001_bootstrap_roles_and_extensions') {
    throw new Error(`Bootstrap inesperado: ${bootstrapped.join(', ')}`)
  }

  // Paso 2: contrasenas fuera de banda.
  const superuser = new Client({ connectionString: superUrl })
  await superuser.connect()
  try {
    await superuser.query(`ALTER ROLE app_migrator WITH PASSWORD '${migratorPassword}'`)
    await superuser.query(`ALTER ROLE app_runtime WITH PASSWORD '${runtimePassword}'`)
  } finally {
    await superuser.end()
  }

  // Paso 3: el resto de migraciones, como app_migrator.
  const migratorUrl = connectionUrl(container, 'app_migrator', migratorPassword)
  const applied = await migrate({ databaseUrl: migratorUrl, direction: 'up' })
  if (applied.length === 0) {
    throw new Error('No se aplico ninguna migracion despues del bootstrap.')
  }

  return {
    container,
    runtimeUrl: connectionUrl(container, 'app_runtime', runtimePassword),
    migratorUrl,
    superUrl,
    runtimeUser: 'app_runtime',
    runtimePassword,
    database: container.getDatabase(),
    internalPort: 5432,
  }
}
