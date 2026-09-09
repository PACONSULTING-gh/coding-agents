import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { runWithTenant } from '@coord/core'
import { Client } from 'pg'
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenantConnection } from '../src/client.js'
import { closeDatabase, configureDatabase, getPoolStats } from '../src/pool.js'

import { COMPOSE_FILE, readServiceEnvironment } from './support/compose.js'
import { startDatabase, type StartedDatabase } from './support/database.js'

/**
 * Criterio de aceptacion literal de T03:
 *
 *   "Dadas 200 conexiones de cliente simultaneas, cuando pasan por PgBouncer,
 *    entonces el numero de conexiones reales a Postgres se mantiene bajo el
 *    pool configurado."
 *
 * Se comprueba con un PgBouncer DE VERDAD delante de un Postgres DE VERDAD, y
 * midiendo las conexiones reales donde se pueden medir de verdad: en
 * `pg_stat_activity`, consultado por una conexion directa a Postgres que no
 * pasa por el pooler. Un mock aqui solo demostraria que el mock hace lo que le
 * hemos dicho (CLAUDE.md 5).
 *
 * De paso comprueba lo que hace que el pooler sea usable para nosotros: que el
 * aislamiento entre tenants sigue en pie cuando 200 clientes se reparten 20
 * backends. Es justo el escenario donde un `SET` de sesion filtraria datos.
 */

/** Misma imagen y version que `infra/docker-compose.yml`. */
const PGBOUNCER_IMAGE = 'edoburu/pgbouncer:v1.25.2-p0'
const PGBOUNCER_PORT = 6432

const CLIENT_CONNECTIONS = 200
const TENANTS = 20

/**
 * Configuracion LEIDA DE `infra/docker-compose.yml`, no escrita a mano aqui.
 * Ver la cabecera de `support/compose.ts`: verificar el criterio sobre una copia
 * de la configuracion no verifica nada del despliegue.
 */
let composeEnv: Readonly<Record<string, string>>
/** `default_pool_size` del compose: el techo en regimen normal. */
let poolSize: number
/** `reserve_pool_size` del compose: los backends extra que se abren tras espera sostenida. */
let reservePoolSize: number

function requiredNumber(env: Readonly<Record<string, string>>, key: string): number {
  const raw = env[key]
  const value = Number(raw)
  if (raw === undefined || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} no es un entero en ${COMPOSE_FILE}. Recibido: ${String(raw)}`)
  }
  return value
}

let network: StartedNetwork
let db: StartedDatabase
let pgbouncer: StartedTestContainer
let admin: Client

interface TenantFixture {
  id: string
  userIds: readonly string[]
}
const tenants: TenantFixture[] = []

async function createTenant(slug: string): Promise<TenantFixture> {
  const id = randomUUID()
  const userIds = [randomUUID(), randomUUID()]
  await runWithTenant({ tenantId: id }, () =>
    withTenantConnection(async (tx) => {
      await tx.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        id,
        `Tenant ${slug}`,
        slug,
      ])
      for (const [index, userId] of userIds.entries()) {
        await tx.query(
          'INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)',
          [userId, id, `user${String(index)}@${slug}.example`, `Usuario ${String(index)}`],
        )
      }
    }),
  )
  return { id, userIds }
}

/** Conexiones reales de `app_runtime` contra Postgres, sin pasar por el pooler. */
async function realBackends(): Promise<number> {
  const result = await admin.query<{ total: string }>(
    `SELECT count(*) AS total
       FROM pg_stat_activity
      WHERE usename = $1 AND backend_type = 'client backend'`,
    [db.runtimeUser],
  )
  return Number(result.rows[0]?.total ?? '0')
}

beforeAll(async () => {
  composeEnv = (await readServiceEnvironment('pgbouncer')).values
  poolSize = requiredNumber(composeEnv, 'DEFAULT_POOL_SIZE')
  reservePoolSize = requiredNumber(composeEnv, 'RESERVE_POOL_SIZE')

  network = await new Network().start()
  db = await startDatabase({ network, networkAlias: 'postgres' })

  // PgBouncer arranca DESPUES de las migraciones porque el rol `app_runtime`
  // lo crea la migracion 0001. La contrasena entra por variable de entorno,
  // como en docker-compose: nunca hay credenciales en el repositorio.
  pgbouncer = await new GenericContainer(PGBOUNCER_IMAGE)
    .withNetwork(network)
    .withEnvironment({
      // Todo lo del compose, tal cual. Lo unico que se sobreescribe es a que
      // Postgres apunta, porque el del compose no es el de este test.
      ...composeEnv,
      DATABASE_URL: `postgres://${db.runtimeUser}:${db.runtimePassword}@postgres:${String(db.internalPort)}/${db.database}`,
    })
    .withExposedPorts(PGBOUNCER_PORT)
    .withWaitStrategy(Wait.forLogMessage(/process up/))
    .start()

  admin = new Client({ connectionString: db.superUrl })
  await admin.connect()

  const url = `postgres://${db.runtimeUser}:${db.runtimePassword}@${pgbouncer.getHost()}:${String(pgbouncer.getMappedPort(PGBOUNCER_PORT))}/${db.database}`
  configureDatabase({
    connectionString: url,
    // Mas alto que las conexiones de cliente que vamos a abrir: el limite que
    // importa lo pone PgBouncer, no este pool.
    max: CLIENT_CONNECTIONS + 20,
    connectionTimeoutMillis: 30_000,
    applicationName: 'coord-db-test',
    allowExitOnIdle: true,
  })

  for (let i = 0; i < TENANTS; i += 1) {
    tenants.push(await createTenant(`pgb-${String(i)}`))
  }
}, 300_000)

afterAll(async () => {
  await closeDatabase()
  await admin?.end()
  await pgbouncer?.stop()
  await db?.stop()
  await network?.stop()
})

describe('la configuracion desplegada es la que este test ejercita', () => {
  it('el pooler del compose esta en modo transaccion y no limpia por transaccion', () => {
    // Estas dos son las que sostienen todo lo demas. Si alguien pone
    // POOL_MODE=session, el pooler deja de multiplexar y ademas se pierde la
    // premisa de la que parte packages/db/src/client.ts. Si alguien pone
    // SERVER_RESET_QUERY_ALWAYS=1, cada transaccion se convierte en dos.
    expect(composeEnv['POOL_MODE'], `POOL_MODE cambio en ${COMPOSE_FILE}`).toBe('transaction')
    expect(
      composeEnv['SERVER_RESET_QUERY_ALWAYS'],
      `SERVER_RESET_QUERY_ALWAYS cambio en ${COMPOSE_FILE}`,
    ).toBe('0')
  })

  it('el contenedor arrancado tiene EXACTAMENTE la configuracion del compose', async () => {
    // No basta con haberle pasado las variables: se leen del pgbouncer.ini que
    // la imagen genera, que es lo que el proceso obedece de verdad.
    const ini = await pgbouncer.exec(['cat', '/etc/pgbouncer/pgbouncer.ini'])
    expect(ini.output).toContain('pool_mode = transaction')
    expect(ini.output).toContain(`default_pool_size = ${String(poolSize)}`)
    expect(ini.output).toContain(`reserve_pool_size = ${String(reservePoolSize)}`)
    expect(ini.output).toContain('server_reset_query_always = 0')
  })
})

describe('PgBouncer en modo transaccion', () => {
  it('la capa de acceso funciona a traves del pooler', async () => {
    const tenant = tenants[0]
    if (tenant === undefined) throw new Error('Fixture ausente.')

    const vistos = await runWithTenant({ tenantId: tenant.id }, () =>
      withTenantConnection(async (tx) => {
        const result = await tx.query<{ id: string }>('SELECT id FROM users')
        return result.rows.map((row) => row.id)
      }),
    )
    expect(vistos.sort()).toEqual([...tenant.userIds].sort())
  })

  it(`${String(CLIENT_CONNECTIONS)} conexiones de cliente simultaneas no abren mas backends que el pool configurado`, async () => {
    let enCurso = true
    let maxBackends = 0
    let maxClientes = 0

    // Muestreo en paralelo mientras las 200 operaciones estan en vuelo. Medir
    // al final no valdria: para entonces PgBouncer ya habria cerrado servidores.
    const muestreo = (async () => {
      while (enCurso) {
        maxBackends = Math.max(maxBackends, await realBackends())
        maxClientes = Math.max(maxClientes, getPoolStats().total)
        await delay(25)
      }
      // Una ultima muestra, por si la operacion termino entre dos muestreos.
      maxBackends = Math.max(maxBackends, await realBackends())
      maxClientes = Math.max(maxClientes, getPoolStats().total)
    })()

    const operaciones = Array.from({ length: CLIENT_CONNECTIONS }, (_unused, index) => {
      const tenant = tenants[index % TENANTS]
      if (tenant === undefined) throw new Error('Fixture ausente.')
      return runWithTenant({ tenantId: tenant.id }, () =>
        withTenantConnection(async (tx) => {
          const result = await tx.query<{ id: string }>('SELECT id FROM users')
          // Mantiene la transaccion abierta un rato para que las 200 se solapen
          // de verdad y PgBouncer tenga que hacer cola.
          await tx.query('SELECT pg_sleep(0.25)')
          return { esperado: tenant, vistos: result.rows.map((row) => row.id) }
        }),
      )
    })

    let resultados
    try {
      resultados = await Promise.all(operaciones)
    } finally {
      enCurso = false
      await muestreo
    }

    // 1. Hubo de verdad 200 conexiones de cliente vivas a la vez.
    expect(
      maxClientes,
      'el test no llego a abrir las 200 conexiones de cliente que dice medir',
    ).toBeGreaterThanOrEqual(CLIENT_CONNECTIONS)

    // 2. La medida de conexiones reales sabe contar: si `realBackends()` se
    //    rompiera y devolviera siempre 0, la asercion siguiente pasaria sola.
    expect(maxBackends, 'no se midio ninguna conexion real: la medida esta rota').toBeGreaterThan(0)

    // 3. Y aun asi las conexiones REALES a Postgres se quedaron bajo el pool.
    //
    //    QUE TECHO SE AFIRMA, Y POR QUE ESE. En regimen normal el techo es
    //    `default_pool_size`. Pero la configuracion desplegada declara ademas
    //    `reserve_pool_size`: cuando un cliente lleva esperando mas de
    //    `reserve_pool_timeout`, PgBouncer abre backends de reserva. Ese es el
    //    techo REAL de lo que se despliega, y es el que se afirma; afirmar solo
    //    `default_pool_size` seria comprobar algo que el despliegue no
    //    garantiza, y el test se volveria intermitente en cuanto la espera se
    //    sostuviera. Los dos numeros salen del compose, no de aqui.
    const techo = poolSize + reservePoolSize
    expect(
      maxBackends,
      `PgBouncer dejo subir las conexiones reales a ${String(maxBackends)}, por encima de ` +
        `default_pool_size(${String(poolSize)}) + reserve_pool_size(${String(reservePoolSize)})`,
    ).toBeLessThanOrEqual(techo)

    //    Y lo que dice el criterio de aceptacion: el pooler multiplica de
    //    verdad. 200 clientes no se traducen en 200 backends ni de lejos.
    expect(maxBackends).toBeLessThan(CLIENT_CONNECTIONS / 4)

    // 4. Y el aislamiento aguanta: 200 clientes repartiendose 20 backends y
    //    ninguno vio datos de otro tenant.
    expect(resultados).toHaveLength(CLIENT_CONNECTIONS)
    for (const { esperado, vistos } of resultados) {
      expect(vistos.slice().sort()).toEqual([...esperado.userIds].sort())
    }
  }, 240_000)
})
