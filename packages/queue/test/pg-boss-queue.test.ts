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

// ===========================================================================
describe('el error del handler se guarda ENTERO, no resumido', () => {
  /**
   * `output` del job es lo unico que le queda a quien investiga un fallo en
   * produccion: el proceso que lo vio ya no existe. Aqui se fija QUE se guarda.
   *
   * Hasta ahora ningun test miraba `output`: se comprobaba que el job acababa
   * en `failed` o en la cola de fallidos, y nada mas. Eso dejaba sin proteger
   * la serializacion entera —la cadena de `cause`, el `code`, el tope de
   * profundidad, y que un `throw` de algo que no es un Error no se pierda—,
   * que es justo lo que se lee el dia del incidente.
   */
  async function outputDelJob(jobId: string): Promise<Record<string, unknown>> {
    const output = await db.sqlValue(`SELECT output FROM queue.job WHERE id = '${jobId}'`)
    if (output === null || typeof output !== 'object') {
      throw new Error(`El job ${jobId} no tiene output: ${JSON.stringify(output)}`)
    }
    return output as Record<string, unknown>
  }

  /** Encola algo que lanza `lanzado` y espera a que el job quede fallado. */
  async function fallarCon(lanzado: unknown): Promise<Record<string, unknown>> {
    const queueName = `test.output.${randomUUID().slice(0, 8)}`
    const queue = newQueue()
    await queue.process(
      queueName,
      // El handler es sincrono a proposito: lo que se prueba es como se
      // serializa lo LANZADO, no como se espera a una promesa.
      () => {
        throw lanzado
      },
      { pollIntervalSeconds: 0.5 },
    )
    await queue.start()

    const jobId = await runWithTenant({ tenantId: randomUUID() }, async () =>
      queue.enqueue(queueName, { n: 1 }, { retryLimit: 0 }),
    )
    await waitFor(
      `el job ${jobId} queda fallado`,
      async () =>
        (await db.sqlValue(`SELECT state FROM queue.job WHERE id = '${jobId}'`)) === 'failed',
      45_000,
    )
    return outputDelJob(jobId)
  }

  it('conserva name, message y el `code` cuando el error lo trae', async () => {
    const error = Object.assign(new Error('la conexion se corto'), { code: 'ECONNRESET' })
    const output = await fallarCon(error)

    expect(output['name']).toBe('Error')
    expect(output['message']).toBe('la conexion se corto')
    // El `code` es lo que distingue un fallo de red de un fallo de logica, y es
    // por lo que se filtra cuando se buscan patrones en el log.
    expect(output['code']).toBe('ECONNRESET')
    expect(typeof output['stack']).toBe('string')
  }, 90_000)

  it('conserva la cadena de causes, y la corta en el nivel 3', async () => {
    // "Perder la cause es perder el error de origen" (cabecera de
    // serializeError). Se comprueban las dos mitades: que la cadena viaja, y
    // que el tope existe -- sin tope, una cadena ciclica cuelga el proceso.
    const raiz = new Error('nivel 4: la raiz')
    const tres = new Error('nivel 3', { cause: raiz })
    const dos = new Error('nivel 2', { cause: tres })
    const uno = new Error('nivel 1', { cause: dos })

    const output = await fallarCon(uno)

    const nivel2 = output['cause'] as Record<string, unknown>
    expect(nivel2['message']).toBe('nivel 2')
    const nivel3 = nivel2['cause'] as Record<string, unknown>
    expect(nivel3['message']).toBe('nivel 3')
    const nivel4 = nivel3['cause'] as Record<string, unknown>
    expect(nivel4['message']).toBe('nivel 4: la raiz')
    // Y aqui se corta: el cuarto nivel ya no lleva su propia cause.
    expect(nivel4['cause']).toBeUndefined()
  }, 90_000)

  it('un error sin cause no inventa el campo', async () => {
    const output = await fallarCon(new Error('a secas'))
    expect(output).not.toHaveProperty('cause')
    expect(output).not.toHaveProperty('code')
  }, 90_000)

  it('lanzar una cadena la guarda tal cual', async () => {
    // `throw 'texto'` es legal en JavaScript y pasa. Si se perdiera, el
    // incidente se investigaria sin saber que se lanzo.
    const output = await fallarCon('esto no es un Error')
    expect(output).toEqual({ value: 'esto no es un Error' })
  }, 90_000)

  it('lanzar un objeto cualquiera lo guarda inspeccionado, no como {}', async () => {
    // `JSON.stringify` de un objeto con propiedades no enumerables o ciclos
    // daria "{}" y se perderia todo. Por eso se usa `inspect`.
    const output = await fallarCon({ motivo: 'objeto suelto', intento: 7 })
    const value = output['value']
    expect(typeof value).toBe('string')
    expect(value).toContain('objeto suelto')
    expect(value).toContain('7')
  }, 90_000)
})

// ===========================================================================
describe('las opciones del llamante llegan a la fila del job, una por una', () => {
  /**
   * `enqueue` traduce `EnqueueOptions` a las opciones de pg-boss campo a campo.
   * Cada linea de ese mapeo es una decision que nadie comprobaba: los tests
   * existentes encolaban con `retryLimit`/`retryDelaySeconds` y ya. Si
   * `singletonKey`, `startAfterSeconds` o `expireInSeconds` dejaran de
   * traducirse, el job se encolaria igual —sin deduplicar, sin retraso o sin
   * caducidad— y todo seguiria verde.
   */
  it('singletonKey, startAfterSeconds, expireInSeconds y retryBackoff acaban en la fila', async () => {
    const queueName = `test.opciones.${randomUUID().slice(0, 8)}`
    const clave = `clave-${randomUUID().slice(0, 8)}`
    const queue = newQueue()
    await queue.start()

    const jobId = await runWithTenant({ tenantId: randomUUID() }, async () =>
      queue.enqueue(
        queueName,
        { n: 1 },
        {
          singletonKey: clave,
          // Muy en el futuro: asi el job no lo recoge nadie y la fila se puede
          // leer con calma.
          startAfterSeconds: 3_600,
          expireInSeconds: 42,
          retryLimit: 9,
          retryDelaySeconds: 11,
          retryBackoff: true,
        },
      ),
    )

    const [fila] = await db.sql(
      `SELECT singleton_key, expire_seconds, retry_limit, retry_delay, retry_backoff,
              start_after > now() + interval '50 minutes' AS muy_en_el_futuro
         FROM queue.job WHERE id = '${jobId}'`,
    )

    expect(fila).toEqual({
      singleton_key: clave,
      expire_seconds: 42,
      retry_limit: 9,
      retry_delay: 11,
      retry_backoff: true,
      muy_en_el_futuro: true,
    })
  }, 90_000)

  it('sin opciones, el job hereda las de la cola y no se inventa ninguna', async () => {
    // La otra mitad del mapeo: cada campo va envuelto en un
    // `opts?.x === undefined ? {} : {...}`. Si esa guarda se rompiera, se
    // mandaria `undefined` explicito y pg-boss escribiria nulos donde deberia
    // haber defaults de la cola.
    const queueName = `test.defaults.${randomUUID().slice(0, 8)}`
    const queue = newQueue()
    await queue.start()

    const jobId = await runWithTenant({ tenantId: randomUUID() }, async () =>
      queue.enqueue(queueName, { n: 1 }),
    )

    const [fila] = await db.sql(
      `SELECT singleton_key, retry_limit, retry_delay, retry_backoff
         FROM queue.job WHERE id = '${jobId}'`,
    )
    expect(fila).toEqual({
      singleton_key: null,
      // Los defaults de ESTA clase, no los de pg-boss (que serian 2 / 0 / false).
      retry_limit: 5,
      retry_delay: 5,
      retry_backoff: true,
    })
  }, 90_000)

  it('schedule guarda el cron y sus opciones de reintento', async () => {
    // El tenant se congela al programar y las opciones viajan a la fila de
    // `queue.schedule`. Nada de esto estaba comprobado: `schedule` no tenia un
    // solo test.
    const queueName = `test.cron.${randomUUID().slice(0, 8)}`
    const tenantId = randomUUID()
    const queue = newQueue()
    await queue.start()

    await runWithTenant({ tenantId }, async () =>
      queue.schedule(
        queueName,
        '0 3 * * *',
        { informe: 'diario' },
        {
          retryLimit: 4,
          retryDelaySeconds: 30,
        },
      ),
    )

    const [fila] = await db.sql(
      `SELECT cron, options, data FROM queue.schedule WHERE name = '${queueName}'`,
    )
    expect(fila?.['cron']).toBe('0 3 * * *')
    expect(fila?.['options']).toEqual({ retryLimit: 4, retryDelay: 30 })
    // Y el envelope lleva el tenant de quien programo, no el de quien dispare.
    expect((fila?.['data'] as Record<string, unknown>)['tenantId']).toBe(tenantId)
  }, 90_000)
})

// ===========================================================================
describe('checkHealth pregunta a la base de datos, no a una variable', () => {
  it('una cola parada no esta sana', async () => {
    const queue = newQueue()
    // Sin start(): un health check que respondiera "ok" aqui mentiria.
    await expect(queue.checkHealth()).rejects.toThrow(QueueNotStartedError)
  }, 90_000)

  it('arrancada y con el esquema puesto, responde', async () => {
    const queue = newQueue()
    await queue.start()
    await expect(queue.checkHealth()).resolves.toBeUndefined()
  }, 90_000)

  it('si el esquema desaparece de debajo, lo dice en vez de responder ok', async () => {
    // Este es el caso que separa un health check de verdad de una lectura de un
    // booleano en memoria: la cola cree estar arrancada y la base ya no tiene
    // su esquema.
    //
    // Va sobre su PROPIA base de datos, y no es un capricho: para poder soltar
    // el esquema hay que cortar antes las conexiones que pg-boss mantiene
    // abiertas (si no, `DROP SCHEMA CASCADE` se queda esperando y acaba en
    // deadlock con su tarea de mantenimiento). Cortarlas en la base compartida
    // tumbaria las colas de los demas tests de este fichero.
    const propia = await startTestDatabase('health')
    try {
      const queue = new PgBossQueue({
        connectionString: propia.url,
        logger: { warn: () => {}, error: () => {} },
      })
      openQueues.push(queue)
      await queue.start()
      await expect(queue.checkHealth()).resolves.toBeUndefined()

      await propia.sql(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()`,
      )
      await propia.sql('DROP SCHEMA queue CASCADE')

      await expect(queue.checkHealth()).rejects.toThrow(/no esta instalado/)
    } finally {
      await propia.drop()
    }
  }, 90_000)
})

// ===========================================================================
describe('la deriva de la cola se corrige Y se registra', () => {
  /**
   * Reconciliar en silencio seria casi tan malo como no reconciliar: el aviso
   * es la unica constancia de que la cola NO estaba como decia la
   * configuracion. El test que ya existia comprobaba los valores finales en la
   * tabla; nadie comprobaba el aviso, asi que se podia quedar mudo.
   */
  function colaConAvisos(retryDefaults: {
    retryLimit: number
    retryDelaySeconds: number
    retryBackoff: boolean
  }): { queue: PgBossQueue; avisos: { contexto: Record<string, unknown>; mensaje: string }[] } {
    const avisos: { contexto: Record<string, unknown>; mensaje: string }[] = []
    const queue = new PgBossQueue({
      connectionString,
      retryDefaults,
      logger: {
        warn: (contexto: Record<string, unknown>, mensaje: string) => {
          avisos.push({ contexto, mensaje })
        },
        error: () => {},
      },
    })
    openQueues.push(queue)
    return { queue, avisos }
  }

  it('nombra la opcion, lo que habia en la base y lo que se aplica', async () => {
    const queueName = `test.deriva.${randomUUID().slice(0, 8)}`

    const primera = colaConAvisos({ retryLimit: 7, retryDelaySeconds: 11, retryBackoff: false })
    await primera.queue.start()
    await runWithTenant({ tenantId: randomUUID() }, async () =>
      primera.queue.enqueue(queueName, { n: 1 }),
    )
    await primera.queue.stop()

    const segunda = colaConAvisos({ retryLimit: 3, retryDelaySeconds: 2, retryBackoff: true })
    await segunda.queue.start()
    await runWithTenant({ tenantId: randomUUID() }, async () =>
      segunda.queue.enqueue(queueName, { n: 2 }),
    )

    const aviso = segunda.avisos.find((a) => a.contexto['queue'] === queueName)
    expect(aviso, 'la cola derivo y no se aviso').toBeDefined()
    expect(aviso?.mensaje).toContain('La cola ya existia con otras opciones')

    const deriva = aviso?.contexto['deriva'] as {
      opcion: string
      enLaBaseDeDatos: unknown
      configurado: unknown
    }[]
    // Cada entrada trae las TRES cosas: sin el valor anterior no se puede
    // reconstruir con que estuvo corriendo la cola hasta ahora.
    const porOpcion = new Map(deriva.map((d) => [d.opcion, d]))
    expect(porOpcion.get('retryLimit')).toEqual({
      opcion: 'retryLimit',
      enLaBaseDeDatos: 7,
      configurado: 3,
    })
    expect(porOpcion.get('retryDelay')).toEqual({
      opcion: 'retryDelay',
      enLaBaseDeDatos: 11,
      configurado: 2,
    })
    expect(porOpcion.get('retryBackoff')).toEqual({
      opcion: 'retryBackoff',
      enLaBaseDeDatos: false,
      configurado: true,
    })
  }, 90_000)

  it('sin deriva no se avisa: el log no se llena de ruido', async () => {
    // La otra mitad. Un aviso que salta siempre deja de leerse, y entonces da
    // igual que sea correcto.
    const queueName = `test.sinderiva.${randomUUID().slice(0, 8)}`
    const config = { retryLimit: 5, retryDelaySeconds: 5, retryBackoff: true }

    const primera = colaConAvisos(config)
    await primera.queue.start()
    await runWithTenant({ tenantId: randomUUID() }, async () =>
      primera.queue.enqueue(queueName, { n: 1 }),
    )
    await primera.queue.stop()

    const segunda = colaConAvisos(config)
    await segunda.queue.start()
    await runWithTenant({ tenantId: randomUUID() }, async () =>
      segunda.queue.enqueue(queueName, { n: 2 }),
    )

    expect(segunda.avisos.filter((a) => a.contexto['queue'] === queueName)).toEqual([])
  }, 90_000)

  it('la cola de fallidos no tiene cola de fallidos propia ni reintenta', async () => {
    // Seria una cadena infinita, y reintentar algo que ya agoto sus reintentos
    // no lo va a arreglar.
    const queueName = `test.dlq.${randomUUID().slice(0, 8)}`
    const queue = newQueue()
    await queue.start()
    await runWithTenant({ tenantId: randomUUID() }, async () => queue.enqueue(queueName, { n: 1 }))

    const [dlq] = await db.sql(
      `SELECT retry_limit, dead_letter FROM queue.queue
        WHERE name = '${PgBossQueue.deadLetterQueueName(queueName)}'`,
    )
    expect(dlq).toEqual({ retry_limit: 0, dead_letter: null })
  }, 90_000)
})

// ===========================================================================
describe('stop() antes de start() no revienta, pero sigue siendo terminal', () => {
  it('parar una cola que nunca arranco no lanza, y despues no se puede arrancar', async () => {
    // El camino de un worker que muere durante el arranque: el `finally` llama
    // a stop() sobre algo que nunca llego a start(). Que eso lance taparia el
    // error de verdad con uno secundario.
    const queue = new PgBossQueue({
      connectionString,
      logger: { warn: () => {}, error: () => {} },
    })
    await expect(queue.stop()).resolves.toBeUndefined()
    await expect(queue.start()).rejects.toThrow(/stop\(\) es terminal/)
  }, 90_000)
})

// ===========================================================================
describe('sobre una cola parada no se opera, y se dice cual era la operacion', () => {
  /**
   * `enqueue`, `schedule` y `checkHealth` empiezan por `#assertStarted`. Sin
   * esa guarda, `enqueue` sobre una cola sin arrancar llegaria a pg-boss con el
   * pool cerrado y fallaria con un error de conexion — que no dice al que llama
   * lo que hizo mal.
   */
  // El retorno se ensancha a `void` a proposito: `enqueue` devuelve el id y las
  // otras dos no. Aqui solo importa que LANCEN, no que devuelvan.
  const operaciones: [string, (q: PgBossQueue) => Promise<void>][] = [
    ['enqueue', async (q) => void (await q.enqueue('cualquiera', { n: 1 }))],
    ['schedule', async (q) => q.schedule('cualquiera', '* * * * *', { n: 1 })],
    ['checkHealth', async (q) => q.checkHealth()],
  ]

  it.each(operaciones)(
    '%s antes de start() falla nombrando la operacion',
    async (operacion, ejecutar) => {
      const queue = new PgBossQueue({
        connectionString,
        logger: { warn: () => {}, error: () => {} },
      })
      openQueues.push(queue)

      await expect(
        runWithTenant({ tenantId: randomUUID() }, () => ejecutar(queue)),
      ).rejects.toThrow(QueueNotStartedError)
      // El nombre de la operacion en el mensaje es lo que convierte "algo fallo"
      // en "llamaste a esto antes de tiempo".
      await expect(
        runWithTenant({ tenantId: randomUUID() }, () => ejecutar(queue)),
      ).rejects.toThrow(new RegExp(`"${operacion}"`))
    },
    90_000,
  )
})

// ===========================================================================
describe('las opciones que APAGAN algo tambien viajan', () => {
  it('retryBackoff: false llega a la fila aunque el default de la cola sea true', async () => {
    // Un booleano que solo se prueba en su valor por defecto no esta probado:
    // si el mapeo se rompiera, el job heredaria el `true` de la cola y el test
    // seguiria verde. Aqui el valor pedido es el CONTRARIO del default.
    const queueName = `test.sinbackoff.${randomUUID().slice(0, 8)}`
    const queue = newQueue()
    await queue.start()

    const jobId = await runWithTenant({ tenantId: randomUUID() }, async () =>
      queue.enqueue(queueName, { n: 1 }, { retryBackoff: false }),
    )

    expect(await db.sqlValue(`SELECT retry_backoff FROM queue.job WHERE id = '${jobId}'`)).toBe(
      false,
    )
  }, 90_000)

  it('schedule sin opciones no inventa opciones', async () => {
    // La otra mitad del mapeo de `schedule`: sin las guardas de `undefined` se
    // escribirian claves con valor nulo en la fila de la programacion.
    const queueName = `test.cronpelado.${randomUUID().slice(0, 8)}`
    const queue = newQueue()
    await queue.start()

    await runWithTenant({ tenantId: randomUUID() }, async () =>
      queue.schedule(queueName, '15 4 * * *', { informe: 'sin opciones' }),
    )

    const opciones = await db.sqlValue(
      `SELECT options FROM queue.schedule WHERE name = '${queueName}'`,
    )
    expect(opciones).toEqual({})
  }, 90_000)
})
