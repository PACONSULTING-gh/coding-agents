import { randomBytes } from 'node:crypto'

import { migrate } from '@coord/db/migrate'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

/**
 * Postgres DE VERDAD para los tests del grafo, con la MISMA separacion de roles
 * que el despliegue real. Nada mockeado (CLAUDE.md 5): lo que se comprueba aqui
 * —que la RLS forzada aisla el grafo, que la CTE recursiva termina en un grafo
 * ciclico y que la consulta de dependencias inversas baja de 200 ms en p95— es
 * comportamiento del motor. Un doble solo demostraria que el doble hace lo que
 * le hemos dicho.
 *
 * ---------------------------------------------------------------------------
 * POR QUE `psql` DENTRO DEL CONTENEDOR Y NO UN CLIENTE `pg`
 * ---------------------------------------------------------------------------
 * Motivo arquitectonico, no de comodidad: la fitness function `pg-solo-en-db`
 * reserva el driver `pg` a packages/db. Este paquete no adquiere acceso directo
 * a Postgres ni siquiera en sus tests; para las dos cosas que no puede hacer la
 * capa de acceso (asignar contrasenas a los roles y un `ANALYZE`) se usa el
 * `psql` que ya trae la imagen. Es el mismo patron que
 * `packages/queue/test/postgres.ts`.
 *
 * ---------------------------------------------------------------------------
 * POR QUE HACEN FALTA DOS ROLES
 * ---------------------------------------------------------------------------
 * `app_migrator` es el DUENO de las tablas y `app_runtime` el que consulta. Si
 * los tests se conectaran como el superusuario del contenedor, se saltarian la
 * RLS por atributo de rol y el test de aislamiento entre tenants pasaria por
 * casualidad, sin comprobar nada.
 */

export const POSTGRES_IMAGE = 'postgres:16-alpine'

export interface StartedDatabase {
  container: StartedPostgreSqlContainer
  /** Conexion del rol de la aplicacion: la que usa `configureDatabase`. */
  runtimeUrl: string
  /** Conexion del rol de migraciones (dueno del esquema). */
  migratorUrl: string
}

/**
 * Contrasena aleatoria por ejecucion. En el repositorio no hay ninguna
 * contrasena, ni siquiera de test (CLAUDE.md 5). Hexadecimal a proposito:
 * `ALTER ROLE ... PASSWORD` no admite parametros y hay que interpolar, asi que
 * el juego de caracteres se restringe a uno que no puede escapar de la cadena.
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
  container: StartedPostgreSqlContainer,
  user: string,
  password: string,
): string {
  assertHex(password)
  return `postgres://${user}:${password}@${container.getHost()}:${String(container.getPort())}/${container.getDatabase()}`
}

/**
 * Ejecuta SQL con el `psql` de la imagen, como superusuario del contenedor.
 *
 * Solo para lo que la capa de acceso no puede hacer: `ALTER ROLE` y `ANALYZE`.
 * NUNCA para comprobar aislamiento — el superusuario se salta la RLS, asi que
 * cualquier assert de aislamiento hecho por aqui seria falso.
 */
export async function psql(container: StartedPostgreSqlContainer, text: string): Promise<string[]> {
  const result = await container.exec(
    [
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      container.getUsername(),
      '-d',
      container.getDatabase(),
      '-tA',
      '-c',
      text,
    ],
    { env: { PGPASSWORD: container.getPassword() } },
  )
  if (result.exitCode !== 0) {
    throw new Error(
      `psql termino con codigo ${String(result.exitCode)}: ${result.stderr || result.output}\nSQL: ${text}`,
    )
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

export async function startDatabase(): Promise<StartedDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start()

  // Paso 1: bootstrap de roles, con el rol privilegiado y SOLO la migracion 0001.
  const superUrl = container.getConnectionUri()
  const bootstrapped = await migrate({ databaseUrl: superUrl, direction: 'up', count: 1 })
  if (bootstrapped[0] !== '0001_bootstrap_roles_and_extensions') {
    throw new Error(`Bootstrap inesperado: ${bootstrapped.join(', ')}`)
  }

  // Paso 2: contrasenas fuera de banda, como en produccion.
  const migratorPassword = generatePassword()
  const runtimePassword = generatePassword()
  assertHex(migratorPassword)
  assertHex(runtimePassword)
  await psql(container, `ALTER ROLE app_migrator WITH PASSWORD '${migratorPassword}'`)
  await psql(container, `ALTER ROLE app_runtime  WITH PASSWORD '${runtimePassword}'`)

  // Paso 3: el resto de migraciones las aplica app_migrator, que queda como
  // dueno de las tablas. Sin eso, `FORCE ROW LEVEL SECURITY` no se ejercitaria.
  const migratorUrl = connectionUrl(container, 'app_migrator', migratorPassword)
  const applied = await migrate({ databaseUrl: migratorUrl, direction: 'up' })
  if (!applied.includes('0007_graph_nodes_and_edges')) {
    throw new Error(
      `La migracion del grafo no se aplico. Aplicadas: ${applied.join(', ') || '(ninguna)'}`,
    )
  }

  return {
    container,
    runtimeUrl: connectionUrl(container, 'app_runtime', runtimePassword),
    migratorUrl,
  }
}
