import { randomUUID } from 'node:crypto'

import { currentTenant, runWithTenant } from '@coord/core'
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { installQueueSchema } from '../src/install.js'
import { PgBossQueue } from '../src/pg-boss-queue.js'
import { sql, sqlValue, startPostgres, waitFor } from './postgres.js'

/**
 * REGRESION de un fallo real, encontrado arrancando el sistema completo en
 * local y NO por los tests que ya existian.
 *
 * Por que se escapo: todos los demas tests de integracion se conectan con el
 * superusuario del contenedor, que puede crear esquemas. En un despliegue de
 * verdad la aplicacion corre como `app_runtime`, sin CREATE sobre la base, y
 * `PgBossQueue.start()` moria con `permission denied for database` porque
 * pg-boss intenta crear su propio esquema al arrancar.
 *
 * Un test que solo prueba el camino privilegiado no prueba el camino que se
 * despliega. Este fija el contrato con un rol de minimo privilegio de verdad.
 */

const RUNTIME_ROLE = 'least_privilege_runtime'
const RUNTIME_PASSWORD = 'test-only-not-a-secret'

let container: StartedPostgreSqlContainer
/** Conexion del dueno: puede hacer DDL. Es el equivalente a app_migrator. */
let ownerUri: string
/** Conexion de la aplicacion: sin CREATE sobre la base. Es app_runtime. */
let runtimeUri: string

const openQueues: PgBossQueue[] = []

function newQueue(connectionString: string): PgBossQueue {
  const queue = new PgBossQueue({
    connectionString,
    logger: { warn: () => {}, error: () => {} },
  })
  openQueues.push(queue)
  return queue
}

beforeAll(async () => {
  container = await startPostgres()
  ownerUri = container.getConnectionUri()

  await sql(
    container,
    `CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${RUNTIME_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
     REVOKE CREATE ON DATABASE ${container.getDatabase()} FROM ${RUNTIME_ROLE};
     REVOKE CREATE ON SCHEMA public FROM ${RUNTIME_ROLE};
     GRANT CONNECT ON DATABASE ${container.getDatabase()} TO ${RUNTIME_ROLE};`,
  )

  const url = new URL(ownerUri)
  url.username = RUNTIME_ROLE
  url.password = RUNTIME_PASSWORD
  runtimeUri = url.toString()
}, 120_000)

afterEach(async () => {
  await Promise.all(openQueues.splice(0).map((q) => q.stop().catch(() => undefined)))
})

afterAll(async () => {
  await container?.stop()
})

describe('installQueueSchema', () => {
  it('sin instalar, el rol de la aplicacion NO puede arrancar la cola por si solo', async () => {
    // Este es el fallo tal cual se manifesto: el proceso muere en el arranque.
    // Si algun dia esto deja de lanzar, es que alguien le ha dado DDL a
    // app_runtime, y eso hay que verlo en rojo.
    await expect(newQueue(runtimeUri).start()).rejects.toThrow(/permission denied/i)

    expect(await sqlValue(container, `SELECT to_regnamespace('queue') IS NULL`)).toBe('t')
  }, 60_000)

  it('tras instalar como dueno, la aplicacion arranca y procesa un job con su tenant', async () => {
    await installQueueSchema({ connectionString: ownerUri, runtimeRole: RUNTIME_ROLE })

    const queue = newQueue(runtimeUri)
    await queue.start()

    const tenantId = randomUUID()
    const jobName = `install.smoke.${randomUUID().slice(0, 8)}`
    let seenTenant: string | undefined

    await queue.process<{ ok: boolean }>(jobName, async () => {
      seenTenant = currentTenant()?.tenantId
      return await Promise.resolve()
    })

    await runWithTenant({ tenantId }, async () => {
      await queue.enqueue(jobName, { ok: true })
    })

    await waitFor(
      'el handler recibe el job',
      () => Promise.resolve(seenTenant !== undefined),
      20_000,
    )
    // El contexto del tenant sobrevive al viaje por la cola, tambien bajo el
    // rol de minimo privilegio.
    expect(seenTenant).toBe(tenantId)
  }, 90_000)

  it('concede CREATE solo en el esquema de la cola, nunca en la base ni en public', async () => {
    await installQueueSchema({ connectionString: ownerUri, runtimeRole: RUNTIME_ROLE })

    const [enQueue, enPublic, enBase, bypass] = await sql(
      container,
      `SELECT has_schema_privilege('${RUNTIME_ROLE}','queue','CREATE');
       SELECT has_schema_privilege('${RUNTIME_ROLE}','public','CREATE');
       SELECT has_database_privilege('${RUNTIME_ROLE}','${container.getDatabase()}','CREATE');
       SELECT rolbypassrls FROM pg_roles WHERE rolname='${RUNTIME_ROLE}';`,
    )

    // pg-boss crea una particion por cola en runtime, asi que CREATE en `queue`
    // es necesario. Lo demas seria abrir la mano de mas.
    expect(enQueue).toBe('t')
    expect(enPublic).toBe('f')
    expect(enBase).toBe('f')
    expect(bypass).toBe('f')
  }, 90_000)

  it('es idempotente: correrlo dos veces no falla', async () => {
    await installQueueSchema({ connectionString: ownerUri, runtimeRole: RUNTIME_ROLE })
    await expect(
      installQueueSchema({ connectionString: ownerUri, runtimeRole: RUNTIME_ROLE }),
    ).resolves.toMatchObject({ schema: 'queue', runtimeRole: RUNTIME_ROLE })
  }, 90_000)

  it('rechaza identificadores que no son simples, en vez de interpolarlos', async () => {
    // El nombre de un rol no se puede pasar como parametro a Postgres, hay que
    // interpolarlo: la validacion es la unica defensa, asi que se prueba.
    for (const evil of ['app_runtime; DROP SCHEMA public CASCADE', 'con-guion', '"comillas"', '']) {
      await expect(
        installQueueSchema({ connectionString: ownerUri, runtimeRole: evil }),
      ).rejects.toThrow(/identificador SQL simple/i)
    }
  }, 30_000)
})
