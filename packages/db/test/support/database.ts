import { createHash } from 'node:crypto'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import type { StartedNetwork } from 'testcontainers'

import { migrate } from '../../src/migrate.js'

import { createTestDatabase, sharedPostgresServer, type TestDatabase } from './postgres-server.js'

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
  /**
   * Solo cuando este montaje tiene su PROPIO contenedor, que hoy es unicamente
   * el test de PgBouncer (ver `startDatabase`). En el camino normal no hay
   * contenedor propio que exponer: se comparte el del proceso.
   */
  container?: StartedPostgreSqlContainer
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
  /**
   * Suelta lo que haya que soltar: borra la base de datos si es del servidor
   * compartido, o para el contenedor si era propio. Los tests llaman a esto y
   * no a `container.stop()`, que solo existe en uno de los dos caminos.
   */
  stop(): Promise<void>
}

function assertHex(password: string): void {
  if (!/^[0-9a-f]+$/.test(password)) {
    throw new Error('La contrasena generada debe ser hexadecimal para poder interpolarse en SQL.')
  }
}

export interface StartDatabaseOptions {
  /** Red de Docker a la que unir el contenedor (para poner PgBouncer delante). */
  network?: StartedNetwork
  /** Alias con el que otros contenedores de esa red resuelven a Postgres. */
  networkAlias?: string
}

/**
 * Clave del advisory lock que serializa el bootstrap de roles. Arbitraria pero
 * fija: lo unico que importa es que todos los procesos usen la misma.
 */
const ROLE_BOOTSTRAP_LOCK_KEY = 0x636f_6f72

/**
 * Contrasena de los roles, DERIVADA del servidor y no aleatoria.
 *
 * No es un capricho ni un descuido de seguridad: es correccion. Las
 * contrasenas se asignan con `ALTER ROLE`, y un rol es del SERVIDOR. Con un
 * servidor compartido y varios procesos a la vez —los trabajadores de una
 * pasada de Stryker— cada uno generaria la suya y se pisarian: el que la
 * cambiase el ultimo dejaria a los demas sin poder abrir conexiones nuevas.
 *
 * Derivandola del propio servidor, todos los procesos calculan EXACTAMENTE la
 * misma, el `ALTER ROLE` se vuelve idempotente y la carrera desaparece.
 *
 * Sigue sin haber ninguna contrasena en el repositorio (CLAUDE.md 5): esto es
 * una funcion de la URL del Postgres DE TEST, que sale del entorno o de un
 * contenedor efimero. En produccion las contrasenas vienen de variables de
 * entorno, como dice la cabecera de la migracion 0001.
 */
function derivedRolePassword(serverUrl: string, role: string): string {
  return createHash('sha256').update(`${serverUrl}\u0000${role}`).digest('hex').slice(0, 48)
}

/**
 * Aplica el bootstrap y el resto de migraciones sobre una base ya creada.
 *
 * Exportada porque `packages/graph` monta su propia variante del mismo patron:
 * necesita `sql()` de superusuario para un `ANALYZE` que la capa de acceso no
 * puede hacer, y eso no cabe en el `StartedDatabase` de aqui. Duplicar estos
 * tres pasos en el otro paquete significaria que el dia que cambie el bootstrap
 * de roles habria que acordarse de los dos sitios.
 */
export async function bootstrapSchema(
  databaseUrl: string,
  adminUrl: string,
  serverUrl: string,
): Promise<{ migratorUrl: string; runtimeUrl: string; runtimePassword: string }> {
  const migratorPassword = derivedRolePassword(serverUrl, 'app_migrator')
  const runtimePassword = derivedRolePassword(serverUrl, 'app_runtime')
  assertHex(migratorPassword)
  assertHex(runtimePassword)

  // Pasos 1 y 2 BAJO UN CERROJO, y no por gusto.
  //
  // Los roles son objetos de CLUSTER: varios ficheros de test arrancando a la
  // vez contra el mismo servidor tocan la misma fila de `pg_authid` y Postgres
  // responde `tuple concurrently updated`. Derivar la contrasena (ver
  // `derivedRolePassword`) quita la carrera SEMANTICA —todos escriben el mismo
  // valor— pero no la FISICA. Medido: 3 de 6 ficheros de `packages/db` caian
  // asi contra un servidor externo.
  //
  // Un advisory lock de SESION vale justo aqui, y no contradice el ADR 0004
  // —que los descarto para los claims— porque alli el problema era sostenerlos
  // durante horas detras de PgBouncer en modo transaccion. Esto es una seccion
  // critica de milisegundos sobre una conexion directa, y se suelta sola al
  // cerrar la sesion.
  //
  // El cerrojo se toma sobre la base POR DEFECTO del servidor (`serverUrl`) y
  // no sobre la de test: los advisory locks tienen ambito de BASE DE DATOS, asi
  // que tomarlo en la base recien creada no excluiria a nadie.
  const lock = new Client({ connectionString: serverUrl })
  await lock.connect()
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [ROLE_BOOTSTRAP_LOCK_KEY])

    // Paso 1: bootstrap de roles con el rol privilegiado. La migracion 0001 ya
    // es idempotente en la creacion de roles (bloque DO con IF NOT EXISTS) y
    // sus GRANT usan `current_database()`, asi que sobre un servidor compartido
    // la segunda base reutiliza los roles y recibe sus propios permisos.
    const bootstrapped = await migrate({ databaseUrl, direction: 'up', count: 1 })
    if (bootstrapped[0] !== '0001_bootstrap_roles_and_extensions') {
      throw new Error(`Bootstrap inesperado: ${bootstrapped.join(', ')}`)
    }

    // Paso 2: contrasenas fuera de banda.
    const superuser = new Client({ connectionString: adminUrl })
    await superuser.connect()
    try {
      await superuser.query(`ALTER ROLE app_migrator WITH PASSWORD '${migratorPassword}'`)
      await superuser.query(`ALTER ROLE app_runtime WITH PASSWORD '${runtimePassword}'`)
    } finally {
      await superuser.end()
    }
  } finally {
    // Cerrar la sesion suelta el advisory lock, pase lo que pase por encima.
    await lock.end()
  }

  // Paso 3: el resto de migraciones, como app_migrator.
  const migratorUrl = withCredentials(databaseUrl, 'app_migrator', migratorPassword)
  const applied = await migrate({ databaseUrl: migratorUrl, direction: 'up' })
  if (applied.length === 0) {
    throw new Error('No se aplico ninguna migracion despues del bootstrap.')
  }

  return {
    migratorUrl,
    runtimeUrl: withCredentials(databaseUrl, 'app_runtime', runtimePassword),
    runtimePassword,
  }
}

function withCredentials(databaseUrl: string, user: string, password: string): string {
  assertHex(password)
  const url = new URL(databaseUrl)
  url.username = user
  url.password = password
  return url.toString()
}

/**
 * El montaje de integracion.
 *
 * DOS CAMINOS, y la diferencia es deliberada (ADR 0007):
 *
 *   - CON `network`: contenedor PROPIO. Es el test de PgBouncer, que necesita
 *     poner un pooler delante sobre una red de Docker; eso exige controlar la
 *     topologia y no basta con tener una URL. Es un unico fichero de test.
 *   - SIN `network`: base de datos nueva dentro del servidor COMPARTIDO del
 *     proceso (`postgres-server.ts`). Antes cada fichero levantaba su
 *     contenedor, y bajo mutation testing eso salia a uno por MUTANTE, con la
 *     puntuacion decidida por los timeouts en vez de por los tests (issue #26).
 */
export async function startDatabase(options: StartDatabaseOptions = {}): Promise<StartedDatabase> {
  if (options.network !== undefined) {
    return startDedicatedDatabase(options)
  }

  const server = await sharedPostgresServer()
  const test: TestDatabase = await createTestDatabase('db')
  const { migratorUrl, runtimeUrl, runtimePassword } = await bootstrapSchema(
    test.url,
    test.adminUrl,
    server.adminUrl,
  )

  return {
    runtimeUrl,
    migratorUrl,
    superUrl: test.url,
    runtimeUser: 'app_runtime',
    runtimePassword,
    database: test.name,
    internalPort: 5432,
    stop: async () => test.drop(),
  }
}

/** El camino con contenedor propio. Solo lo usa el test de PgBouncer. */
async function startDedicatedDatabase(options: StartDatabaseOptions): Promise<StartedDatabase> {
  let builder = new PostgreSqlContainer(POSTGRES_IMAGE)
  if (options.network !== undefined) {
    builder = builder.withNetwork(options.network)
  }
  if (options.networkAlias !== undefined) {
    builder = builder.withNetworkAliases(options.networkAlias)
  }
  const container = await builder.start()
  const superUrl = container.getConnectionUri()
  const { migratorUrl, runtimeUrl, runtimePassword } = await bootstrapSchema(
    superUrl,
    superUrl,
    superUrl,
  )

  return {
    container,
    runtimeUrl,
    migratorUrl,
    superUrl,
    runtimeUser: 'app_runtime',
    runtimePassword,
    database: container.getDatabase(),
    internalPort: 5432,
    stop: async () => {
      await container.stop()
    },
  }
}
