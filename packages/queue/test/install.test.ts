import { randomUUID } from 'node:crypto'

import { currentTenant, runWithTenant } from '@coord/core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { installQueueSchema } from '../src/install.js'
import { PgBossQueue } from '../src/pg-boss-queue.js'
import { startTestDatabase, waitFor, type TestDatabase } from './postgres.js'

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

/**
 * El nombre del rol se deriva del de la base de datos, y NO es cosmetico: un rol
 * de Postgres pertenece al SERVIDOR, no a la base. Desde que el servidor es
 * compartido (ADR 0007) un nombre fijo haria que el segundo arranque de este
 * fichero —el segundo mutante, en una pasada de Stryker— muriera con "role
 * already exists".
 */
let RUNTIME_ROLE: string
const RUNTIME_PASSWORD = 'test-only-not-a-secret'

let db: TestDatabase
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
  db = await startTestDatabase('install')
  ownerUri = db.url
  RUNTIME_ROLE = `lpr_${db.name}`

  await db.sql(
    `CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${RUNTIME_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
     REVOKE CREATE ON DATABASE ${db.name} FROM ${RUNTIME_ROLE};
     REVOKE CREATE ON SCHEMA public FROM ${RUNTIME_ROLE};
     GRANT CONNECT ON DATABASE ${db.name} TO ${RUNTIME_ROLE};`,
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
  // El rol es del SERVIDOR: si no se borra aqui, sobrevive a la base y va
  // llenando un servidor externo de roles muertos.
  await db.sql(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`).catch(() => undefined)
  await db.drop()
})

describe('installQueueSchema', () => {
  it('sin instalar, el rol de la aplicacion NO puede arrancar la cola por si solo', async () => {
    // Este es el fallo tal cual se manifesto: el proceso muere en el arranque.
    // Si algun dia esto deja de lanzar, es que alguien le ha dado DDL a
    // app_runtime, y eso hay que verlo en rojo.
    await expect(newQueue(runtimeUri).start()).rejects.toThrow(/permission denied/i)

    expect(await db.sqlValue(`SELECT to_regnamespace('queue') IS NULL`)).toBe(true)
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

    const [enQueue, enPublic, enBase, bypass] = await db.sqlColumn(
      `SELECT has_schema_privilege('${RUNTIME_ROLE}','queue','CREATE');
       SELECT has_schema_privilege('${RUNTIME_ROLE}','public','CREATE');
       SELECT has_database_privilege('${RUNTIME_ROLE}','${db.name}','CREATE');
       SELECT rolbypassrls FROM pg_roles WHERE rolname='${RUNTIME_ROLE}';`,
    )

    // pg-boss crea una particion por cola en runtime, asi que CREATE en `queue`
    // es necesario. Lo demas seria abrir la mano de mas.
    expect(enQueue).toBe(true)
    expect(enPublic).toBe(false)
    expect(enBase).toBe(false)
    expect(bypass).toBe(false)
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
