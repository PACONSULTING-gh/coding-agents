import { randomUUID } from 'node:crypto'

import { MissingTenantContextError, currentTenant, runWithTenant } from '@coord/core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { QueueNotStartedError } from '../src/errors.js'
import { PgBossQueue } from '../src/pg-boss-queue.js'
import { delay, startTestDatabase, waitFor, type TestDatabase } from './postgres.js'

/**
 * Tests de integracion de la implementacion de QueuePort sobre pg-boss.
 *
 * Todas las evidencias que se afirman estan PERSISTIDAS EN LA BASE DE DATOS
 * (tabla `job_run` y las propias tablas de pg-boss), nunca en variables en
 * memoria del proceso de test: un contador en memoria no distingue "el job se
 * ejecuto una vez" de "el job se ejecuto una vez en este proceso".
 */

let db: TestDatabase
let connectionString: string

/** Instancias creadas por cada test, para pararlas pase lo que pase. */
let openQueues: PgBossQueue[] = []

function newQueue(): PgBossQueue {
  const queue = new PgBossQueue({
    connectionString,
    // Silencia el ruido esperado de los tests que provocan fallos a proposito,
    // pero sin perder la senal: los errores inesperados siguen apareciendo.
    logger: { warn: () => {}, error: () => {} },
  })
  openQueues.push(queue)
  return queue
}

beforeAll(async () => {
  db = await startTestDatabase('pgboss')
  connectionString = db.url
  await db.sql(`CREATE TABLE job_run (
       id           bigserial PRIMARY KEY,
       queue_name   text        NOT NULL,
       job_id       uuid        NOT NULL,
       tenant_id    uuid        NOT NULL,
       worker_index int         NOT NULL,
       note         text,
       ran_at       timestamptz NOT NULL DEFAULT clock_timestamp()
     )`)
}, 120_000)

afterEach(async () => {
  const queues = openQueues
  openQueues = []
  await Promise.all(queues.map(async (queue) => queue.stop()))
})

afterAll(async () => {
  // Se borra la BASE, no el servidor: el servidor es compartido por el proceso
  // y puede ser externo (ADR 0007).
  await db.drop()
})

/** Registra en la base de datos que un handler se ejecuto. */
async function recordRun(args: {
  queueName: string
  jobId: string
  tenantId: string
  workerIndex: number
  note?: string
}): Promise<void> {
  const note = args.note === undefined ? 'NULL' : `'${args.note}'`
  await db.sql(`INSERT INTO job_run (queue_name, job_id, tenant_id, worker_index, note)
     VALUES ('${args.queueName}', '${args.jobId}', '${args.tenantId}', ${args.workerIndex}, ${note})`)
}

async function countRuns(queueName: string): Promise<number> {
  const value = await db.sqlValue(`SELECT count(*) FROM job_run WHERE queue_name = '${queueName}'`)
  return Number(value)
}

describe('exactly-once con varios workers', () => {
  it('ejecuta el handler una sola vez aunque haya 3 workers compitiendo', async () => {
    const queueName = `test.exactly-once.${randomUUID().slice(0, 8)}`
    const tenantId = randomUUID()

    const producer = newQueue()
    await producer.start()

    const workers = [0, 1, 2].map(() => newQueue())
    await Promise.all(
      workers.map(async (worker, workerIndex) =>
        worker.process<{ marker: string }>(
          queueName,
          async (job) => {
            await recordRun({
              queueName,
              jobId: job.id,
              tenantId: job.tenantId,
              workerIndex,
              note: job.payload.marker,
            })
          },
          { pollIntervalSeconds: 0.5 },
        ),
      ),
    )
    await Promise.all(workers.map(async (worker) => worker.start()))

    const jobId = await runWithTenant({ tenantId }, async () =>
      producer.enqueue(queueName, { marker: 'una-sola-vez' }),
    )
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/)

    await waitFor('el job se procesa', async () => (await countRuns(queueName)) >= 1)
    // Ventana generosa por encima del intervalo de polling: si algun otro
    // worker fuese a recoger el mismo job, aqui es donde se veria.
    await delay(3_000)

    expect(await countRuns(queueName)).toBe(1)

    const state = await db.sqlValue(`SELECT state FROM queue.job WHERE id = '${jobId}'`)
    expect(state).toBe('completed')
  })
})

describe('propagacion del contexto de tenant', () => {
  it('restaura dentro del handler el tenant en el que se encolo', async () => {
    const queueName = `test.tenant.${randomUUID().slice(0, 8)}`
    const tenantId = randomUUID()
    const requestId = randomUUID()

    const queue = newQueue()
    let seenTenantId: string | undefined
    let seenRequestId: string | undefined
    let envelopeTenantId: string | undefined

    await queue.process<{ n: number }>(
      queueName,
      async (job) => {
        seenTenantId = currentTenant()?.tenantId
        seenRequestId = currentTenant()?.requestId
        envelopeTenantId = job.tenantId
        await recordRun({ queueName, jobId: job.id, tenantId: job.tenantId, workerIndex: 0 })
      },
      { pollIntervalSeconds: 0.5 },
    )
    await queue.start()

    await runWithTenant({ tenantId, requestId }, async () => queue.enqueue(queueName, { n: 1 }))

    await waitFor('el job se procesa', async () => (await countRuns(queueName)) >= 1)

    expect(seenTenantId).toBe(tenantId)
    expect(envelopeTenantId).toBe(tenantId)
    expect(seenRequestId).toBe(requestId)
  })

  it('no mezcla el contexto entre dos jobs de tenants distintos procesados a la vez', async () => {
    const queueName = `test.tenant-concurrente.${randomUUID().slice(0, 8)}`
    const tenantA = randomUUID()
    const tenantB = randomUUID()

    // Barrera: ningun handler sale hasta que los DOS estan dentro. Si la
    // concurrencia no llegase a darse, el test caduca en vez de pasar por
    // casualidad comprobando dos ejecuciones secuenciales.
    let arrived = 0
    let openGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })

    const observations: {
      expected: string
      before: string | undefined
      after: string | undefined
    }[] = []

    const workers = [0, 1].map(() => newQueue())
    await Promise.all(
      workers.map(async (worker, workerIndex) =>
        worker.process<{ expected: string }>(
          queueName,
          async (job) => {
            const before = currentTenant()?.tenantId
            arrived += 1
            if (arrived === 2) {
              openGate()
            }
            await gate
            const after = currentTenant()?.tenantId
            observations.push({ expected: job.payload.expected, before, after })
            await recordRun({
              queueName,
              jobId: job.id,
              tenantId: job.tenantId,
              workerIndex,
            })
          },
          { pollIntervalSeconds: 0.5 },
        ),
      ),
    )
    await Promise.all(workers.map(async (worker) => worker.start()))

    const producer = newQueue()
    await producer.start()
    await runWithTenant({ tenantId: tenantA }, async () =>
      producer.enqueue(queueName, { expected: tenantA }),
    )
    await runWithTenant({ tenantId: tenantB }, async () =>
      producer.enqueue(queueName, { expected: tenantB }),
    )

    await waitFor('se procesan los dos jobs', async () => (await countRuns(queueName)) >= 2)

    expect(observations).toHaveLength(2)
    for (const observation of observations) {
      // Antes y despues del `await` compartido: el AsyncLocalStorage de cada
      // job es suyo, no se contamina con el del otro.
      expect(observation.before).toBe(observation.expected)
      expect(observation.after).toBe(observation.expected)
    }
    expect(new Set(observations.map((o) => o.expected))).toEqual(new Set([tenantA, tenantB]))

    const tenantsPersisted = await db.sqlColumn(
      `SELECT DISTINCT tenant_id FROM job_run WHERE queue_name = '${queueName}' ORDER BY 1`,
    )
    expect(new Set(tenantsPersisted)).toEqual(new Set([tenantA, tenantB]))
  })
})

describe('reintentos', () => {
  it('reintenta con intervalos crecientes y acaba en la cola de fallidos', async () => {
    const queueName = `test.retry.${randomUUID().slice(0, 8)}`
    const deadLetterName = PgBossQueue.deadLetterQueueName(queueName)
    const tenantId = randomUUID()
    const retryLimit = 2
    const retryDelaySeconds = 1

    const queue = newQueue()
    await queue.process(
      queueName,
      async (job) => {
        await recordRun({
          queueName,
          jobId: job.id,
          tenantId: job.tenantId,
          workerIndex: 0,
          note: `intento-${job.retryCount}`,
        })
        throw new Error('fallo deliberado del handler')
      },
      { pollIntervalSeconds: 0.5 },
    )
    await queue.start()

    const jobId = await runWithTenant({ tenantId }, async () =>
      queue.enqueue(
        queueName,
        { payload: 'da-igual' },
        { retryLimit, retryDelaySeconds, retryBackoff: true },
      ),
    )

    const expectedAttempts = retryLimit + 1
    await waitFor(
      `${expectedAttempts} intentos del handler`,
      async () => (await countRuns(queueName)) >= expectedAttempts,
      45_000,
    )

    // Un intento por cada retryCount: 0, 1, 2. Ni uno de mas.
    const notes = await db.sqlColumn(
      `SELECT note FROM job_run WHERE queue_name = '${queueName}' ORDER BY ran_at`,
    )
    expect(notes).toEqual(['intento-0', 'intento-1', 'intento-2'])

    // Los huecos entre intentos crecen. Se afirma el SUELO garantizado por la
    // formula de pg-boss -- retryDelay * 2^(n-1) para el intento n -- y no
    // "gap2 > gap1" a secas: la mitad superior del intervalo es jitter
    // aleatorio, asi que una comparacion directa entre muestras seria
    // intermitente por diseno. El suelo, en cambio, es determinista y ya
    // demuestra el crecimiento: 1 s, luego 2 s.
    const gapsRaw =
      await db.sqlColumn(`SELECT EXTRACT(EPOCH FROM ran_at - lag(ran_at) OVER (ORDER BY ran_at))
         FROM job_run WHERE queue_name = '${queueName}' ORDER BY ran_at OFFSET 1`)
    const gaps = gapsRaw.map(Number)
    expect(gaps).toHaveLength(retryLimit)
    expect(gaps[0]).toBeGreaterThanOrEqual(retryDelaySeconds * 1)
    expect(gaps[1]).toBeGreaterThanOrEqual(retryDelaySeconds * 2)

    // Y el TECHO, que es igual de determinista: el retraso del intento n cae en
    // [retryDelay*2^(n-1), retryDelay*2^n). Sin esta cota, un backoff plano
    // (jitter apagado, siempre el suelo) y uno desbocado (minutos entre
    // intentos) pasaban los dos. El margen cubre el intervalo de polling del
    // worker y el tiempo del propio handler, no el crecimiento del backoff.
    const MARGEN_DE_POLLING_S = 3
    expect(gaps[0]).toBeLessThan(retryDelaySeconds * 2 + MARGEN_DE_POLLING_S)
    expect(gaps[1]).toBeLessThan(retryDelaySeconds * 4 + MARGEN_DE_POLLING_S)

    // Estado final leido de la tabla, no inferido.
    await waitFor(
      'el job termina en estado failed',
      async () =>
        (await db.sqlValue(`SELECT state FROM queue.job WHERE id = '${jobId}'`)) === 'failed',
    )
    await waitFor(
      'aparece la copia en la cola de fallidos',
      async () =>
        Number(
          await db.sqlValue(`SELECT count(*) FROM queue.job WHERE name = '${deadLetterName}'`),
        ) === 1,
    )

    const deadLettered = await db.sqlColumn(
      `SELECT source_id::text FROM queue.job WHERE name = '${deadLetterName}'`,
    )
    expect(deadLettered).toEqual([jobId])
  })
})

describe('contexto de tenant obligatorio', () => {
  it('encolar sin contexto de tenant lanza y no crea ningun job', async () => {
    const queueName = `test.sin-tenant.${randomUUID().slice(0, 8)}`
    const queue = newQueue()
    await queue.start()

    await expect(queue.enqueue(queueName, { a: 1 })).rejects.toBeInstanceOf(
      MissingTenantContextError,
    )
    await expect(queue.schedule(queueName, '* * * * *', { a: 1 })).rejects.toBeInstanceOf(
      MissingTenantContextError,
    )

    const jobs = await db.sqlValue(`SELECT count(*) FROM queue.job WHERE name = '${queueName}'`)
    expect(Number(jobs)).toBe(0)
  })
})

describe('envelope invalido: frontera de confianza', () => {
  it('un envelope corrupto no llega al handler y va a fallidos sin reintentos', async () => {
    const queueName = `test.envelope-roto.${randomUUID().slice(0, 8)}`
    const deadLetterName = PgBossQueue.deadLetterQueueName(queueName)
    const tenantId = randomUUID()

    // Se encola diferido para que la cola (y su dlq) existan y el job este en la
    // tabla SIN que ningun worker lo haya podido tocar todavia.
    const producer = newQueue()
    await producer.start()
    const jobId = await runWithTenant({ tenantId }, async () =>
      producer.enqueue(queueName, { valido: true }, { startAfterSeconds: 3_600, retryLimit: 5 }),
    )

    // Se corrompe la fila como lo haria un productor de otra version: el
    // envelope deja de cumplir el contrato.
    await db.sql(
      `UPDATE queue.job SET data = '{"roto":true}', start_after = now() WHERE id = '${jobId}'`,
    )

    let handlerEjecutado = false
    const worker = newQueue()
    await worker.process(
      queueName,
      async (job) => {
        handlerEjecutado = true
        await recordRun({ queueName, jobId: job.id, tenantId, workerIndex: 0 })
      },
      { pollIntervalSeconds: 0.5 },
    )
    await worker.start()

    await waitFor(
      'el job corrupto aparece en la cola de fallidos',
      async () =>
        Number(
          await db.sqlValue(`SELECT count(*) FROM queue.job WHERE name = '${deadLetterName}'`),
        ) === 1,
    )

    // Lo importante: el handler NUNCA se ejecuto. Un envelope sin tenantId
    // valido no puede procesarse, porque no hay a quien atribuirlo.
    expect(handlerEjecutado).toBe(false)
    expect(await countRuns(queueName)).toBe(0)

    const dlqSource = await db.sqlColumn(
      `SELECT source_id::text FROM queue.job WHERE name = '${deadLetterName}'`,
    )
    expect(dlqSource).toEqual([jobId])

    // Y NO se reintento: reintentar no va a hacer valido un payload roto.
    const retryCount = await db.sqlValue(`SELECT retry_count FROM queue.job WHERE id = '${jobId}'`)
    expect(Number(retryCount)).toBe(0)
  })
})

describe('deduplicacion por clave de unicidad', () => {
  it('con la politica por defecto, singletonKey NO deduplica: crea dos jobs', async () => {
    // Este test fija el comportamiento REAL, que no es el que sugiere el nombre
    // de la opcion. Con la politica `standard` -la que crea esta clase-,
    // pg-boss 12.30.0 no suprime nada por `singletonKey`. Quien necesite
    // "una sola vez" tiene que deduplicar en su propio almacen (apps/webhook lo
    // hace con la restriccion unica de webhook_deliveries). Si algun dia se
    // anade una politica de cola con supresion, este test lo dira.
    const queueName = `test.singleton.${randomUUID().slice(0, 8)}`
    const tenantId = randomUUID()
    const singletonKey = `entrega-${randomUUID()}`

    const queue = newQueue()
    await queue.start()

    const primero = await runWithTenant({ tenantId }, async () =>
      queue.enqueue(queueName, { intento: 1 }, { singletonKey }),
    )
    const segundo = await runWithTenant({ tenantId }, async () =>
      queue.enqueue(queueName, { intento: 2 }, { singletonKey }),
    )

    expect(primero).toMatch(/^[0-9a-f-]{36}$/)
    expect(segundo).toMatch(/^[0-9a-f-]{36}$/)
    expect(segundo).not.toBe(primero)

    const total = await db.sqlValue(`SELECT count(*) FROM queue.job WHERE name = '${queueName}'`)
    expect(Number(total)).toBe(2)

    // Y lo que si esta garantizado: ningun `enqueue` devuelve un id que no
    // exista en la tabla. Ese es el contrato que protege DuplicateJobError.
    const existentes = await db.sqlColumn(
      `SELECT id::text FROM queue.job WHERE name = '${queueName}' ORDER BY 1`,
    )
    expect(existentes.slice().sort()).toEqual([primero, segundo].sort())
  })
})

describe('reconciliacion de las opciones de la cola', () => {
  it('una cola que ya existia adopta las opciones de la instancia nueva', async () => {
    const queueName = `test.reconciliar.${randomUUID().slice(0, 8)}`
    const tenantId = randomUUID()

    const primera = new PgBossQueue({
      connectionString,
      logger: { warn: () => {}, error: () => {} },
      retryDefaults: { retryLimit: 7, retryDelaySeconds: 11, retryBackoff: false },
    })
    openQueues.push(primera)
    await primera.start()
    await runWithTenant({ tenantId }, async () => primera.enqueue(queueName, { n: 1 }))
    await primera.stop()

    const antes = await db.sql(
      `SELECT retry_limit, retry_delay, retry_backoff FROM queue.queue WHERE name = '${queueName}'`,
    )
    // Fila entera y con sus tipos, en vez de la cadena '7|11|f' que devolvia
    // `psql -tA`: se lee mejor y no depende del formateo de una herramienta.
    expect(antes).toEqual([{ retry_limit: 7, retry_delay: 11, retry_backoff: false }])

    // `createQueue` es un INSERT ... ON CONFLICT DO NOTHING: sin reconciliacion,
    // esta segunda instancia dejaba la cola con los valores de la primera y sus
    // propios defaults no llegaban nunca a produccion.
    const segunda = new PgBossQueue({
      connectionString,
      logger: { warn: () => {}, error: () => {} },
      retryDefaults: { retryLimit: 3, retryDelaySeconds: 2, retryBackoff: true },
    })
    openQueues.push(segunda)
    await segunda.start()
    await runWithTenant({ tenantId }, async () => segunda.enqueue(queueName, { n: 2 }))

    const despues = await db.sql(
      `SELECT retry_limit, retry_delay, retry_backoff FROM queue.queue WHERE name = '${queueName}'`,
    )
    expect(despues).toEqual([{ retry_limit: 3, retry_delay: 2, retry_backoff: true }])

    // Y la cola de fallidos sigue enganchada: reconciliar no la desengancha.
    const deadLetter = await db.sqlValue(
      `SELECT dead_letter FROM queue.queue WHERE name = '${queueName}'`,
    )
    expect(deadLetter).toBe(PgBossQueue.deadLetterQueueName(queueName))
  })
})

describe('ciclo de vida: stop() es terminal', () => {
  it('un start() posterior a stop() falla en voz alta en vez de arrancar sin workers', async () => {
    const queueName = `test.ciclo.${randomUUID().slice(0, 8)}`
    const queue = newQueue()
    await queue.process(queueName, async () => {}, { pollIntervalSeconds: 0.5 })
    await queue.start()
    await queue.stop()

    // Antes, este start() devolvia normalmente y dejaba la instancia SIN ningun
    // worker registrado: los jobs se encolaban y nadie los procesaba.
    await expect(queue.start()).rejects.toBeInstanceOf(QueueNotStartedError)
    await expect(
      runWithTenant({ tenantId: randomUUID() }, async () => queue.enqueue(queueName, { n: 1 })),
    ).rejects.toBeInstanceOf(QueueNotStartedError)
  })
})
