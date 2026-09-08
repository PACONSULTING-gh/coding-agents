import { inspect } from 'node:util'

import type {
  EnqueueOptions,
  JobEnvelope,
  JobHandler,
  ProcessOptions,
  QueuePort,
  ScheduleOptions,
} from '@coord/core'
import { requireTenant, runWithTenant } from '@coord/core'
import { PgBoss } from 'pg-boss'
import type { JobResult, JobWithMetadata, SendOptions } from 'pg-boss'

import { buildEnvelope, parseEnvelope, tenantContextFrom } from './envelope.js'
import { DuplicateJobError, QueueNotStartedError } from './errors.js'
import { consoleLogger, type QueueLogger } from './logger.js'

/**
 * Esquema propio para las tablas de pg-boss. No se instala en `public` para
 * que el esquema de la cola y el de dominio (packages/db) se puedan conceder,
 * migrar y auditar por separado.
 */
export const DEFAULT_QUEUE_SCHEMA = 'queue'

/**
 * Politica de reintentos por defecto. Se aplica a la cola entera al crearla, y
 * cada `enqueue` puede sobreescribirla job a job.
 *
 *   - 5 reintentos: suficiente para aguantar un despliegue o un corte breve de
 *     un servicio externo (GitHub), sin que un job envenenado se pase el dia
 *     rebotando.
 *   - 5 s de retraso base con backoff exponencial: el primer reintento llega
 *     rapido, y el sexto ya esta a decenas de minutos.
 *   - tope de 1 h entre reintentos: sin tope, 2^n se va a dias.
 *
 * El backoff exponencial CON JITTER lo aporta pg-boss de forma nativa cuando
 * `retryBackoff` esta activo. La formula que aplica en SQL al fallar un job es:
 *
 *   start_after = now() + LEAST(
 *       retry_delay_max,
 *       GREATEST(retry_delay, 1) * ( 2^n/2 + 2^n/2 * random() )
 *   ) * interval '1s'                       con n = LEAST(16, retry_count + 1)
 *
 * Es decir, el retraso del intento n cae uniformemente en
 * [retryDelay * 2^(n-1), retryDelay * 2^n): la mitad determinista y la otra
 * mitad aleatoria. No hace falta -ni conviene- anadir jitter por encima: seria
 * jitter sobre jitter y desdibujaria el suelo garantizado del intervalo.
 */
export const DEFAULT_RETRY_LIMIT = 5
export const DEFAULT_RETRY_DELAY_SECONDS = 5
export const DEFAULT_RETRY_BACKOFF = true
export const DEFAULT_RETRY_DELAY_MAX_SECONDS = 3_600

/** Margen que se le da a `stop()` para que terminen los jobs en vuelo. */
export const DEFAULT_STOP_TIMEOUT_MS = 30_000

/** Sufijo de la cola de fallidos asociada a cada cola. */
const DEAD_LETTER_SUFFIX = '.dlq'

export interface RetryDefaults {
  retryLimit?: number
  retryDelaySeconds?: number
  retryBackoff?: boolean
  retryDelayMaxSeconds?: number
}

export interface PgBossQueueOptions {
  /**
   * Cadena de conexion a PostgreSQL. Tiene que ser la conexion DIRECTA a
   * Postgres, no la de PgBouncer en modo transaccion: ver la nota de
   * `PgBossQueue` y el README del paquete.
   */
  connectionString: string
  /** Esquema donde vive la instalacion de pg-boss. Por defecto, `queue`. */
  schema?: string
  /** Logger estructurado. Por defecto escribe JSON a stderr. */
  logger?: QueueLogger
  /** Politica de reintentos por defecto de las colas que cree esta instancia. */
  retryDefaults?: RetryDefaults
  /** Milisegundos que espera `stop()` a los jobs en vuelo antes de cortar. */
  stopTimeoutMs?: number
  /** Tamano maximo del pool propio de pg-boss. */
  maxConnections?: number
}

interface RegisteredWork {
  name: string
  register: () => Promise<void>
}

/**
 * Opciones de cola que esta clase gobierna. Deliberadamente NO es el tipo de
 * pg-boss: se compara y se aplica exactamente este conjunto, ni mas ni menos,
 * para no pisar en silencio ajustes que alguien haya hecho fuera.
 */
interface DesiredQueueOptions {
  retryLimit: number
  retryDelay?: number
  retryBackoff?: boolean
  retryDelayMax?: number
  deadLetter?: string
}

/**
 * Convierte cualquier cosa lanzada en algo que se puede loguear y guardar como
 * `output` del job. La cadena de `cause` se conserva -- perderla es perder el
 * error de origen (CLAUDE.md 5) -- con un limite de profundidad por si alguien
 * construye una cadena ciclica.
 */
function serializeError(error: unknown, depth = 0): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...(error.cause === undefined || depth >= 3
        ? {}
        : { cause: serializeError(error.cause, depth + 1) }),
    }
  }
  return { value: typeof error === 'string' ? error : inspect(error, { depth: 2 }) }
}

/**
 * Implementacion de `QueuePort` (packages/core) sobre pg-boss.
 *
 * ADVERTENCIA DE DESPLIEGUE — CONEXION DIRECTA, NUNCA PgBouncer EN MODO
 * TRANSACCION:
 * pg-boss gestiona su propio pool de conexiones y necesita conexiones con
 * estado de sesion (la conexion dedicada de LISTEN/NOTIFY, que queda fijada a
 * una sesion). PgBouncer en modo transaccion devuelve la conexion al pool en
 * cada COMMIT, con lo que ese estado se pierde y las notificaciones se quedan
 * en una sesion que ya no es la nuestra. La decision de arquitectura de usar
 * PgBouncer (CLAUDE.md 3) aplica a la capa de datos de packages/db, NO a este
 * paquete: aqui se usa `DATABASE_URL` (Postgres directo), no `PGBOUNCER_URL`.
 * Si alguien apunta esta clase a PgBouncer, los sintomas van desde jobs que
 * tardan en despertarse hasta errores intermitentes de conexion.
 *
 * pg-boss es un detalle de implementacion: no debe filtrarse ni un tipo suyo
 * por la API publica de este paquete. Lo comprueba una fitness function
 * (`test/no-pg-boss-imports.test.ts`) ademas de dependency-cruiser.
 */
export class PgBossQueue implements QueuePort {
  readonly #boss: PgBoss
  readonly #logger: QueueLogger
  readonly #retryDefaults: Required<RetryDefaults>
  readonly #stopTimeoutMs: number
  readonly #ensured = new Map<string, Promise<void>>()
  readonly #pendingWork: RegisteredWork[] = []
  #started = false
  /** `stop()` cierra el pool de pg-boss: la instancia no vuelve a servir. */
  #stopped = false

  constructor(options: PgBossQueueOptions) {
    this.#logger = options.logger ?? consoleLogger
    this.#stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
    this.#retryDefaults = {
      retryLimit: options.retryDefaults?.retryLimit ?? DEFAULT_RETRY_LIMIT,
      retryDelaySeconds: options.retryDefaults?.retryDelaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS,
      retryBackoff: options.retryDefaults?.retryBackoff ?? DEFAULT_RETRY_BACKOFF,
      retryDelayMaxSeconds:
        options.retryDefaults?.retryDelayMaxSeconds ?? DEFAULT_RETRY_DELAY_MAX_SECONDS,
    }
    this.#boss = new PgBoss({
      connectionString: options.connectionString,
      schema: options.schema ?? DEFAULT_QUEUE_SCHEMA,
      ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
    })
    // pg-boss es un EventEmitter: sin un listener de 'error', un fallo de fondo
    // (mantenimiento, reconexion) tumbaria el proceso con un error no capturado.
    // Escucharlo no es tragarselo: se registra con contexto.
    this.#boss.on('error', (error: unknown) => {
      this.#logger.error({ error: serializeError(error) }, 'Error interno de la cola')
    })
    this.#boss.on('warning', (warning: unknown) => {
      this.#logger.warn({ warning }, 'Aviso interno de la cola')
    })
  }

  /**
   * Construye la cola desde el entorno. Espera `DATABASE_URL` (conexion
   * directa a Postgres). Falla ruidosamente si no esta: arrancar un worker
   * sin base de datos solo retrasa el error hasta el primer job.
   */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    overrides: Omit<PgBossQueueOptions, 'connectionString'> = {},
  ): PgBossQueue {
    const connectionString = env['DATABASE_URL']
    if (connectionString === undefined || connectionString.trim() === '') {
      throw new QueueNotStartedError(
        'Falta DATABASE_URL: la cola necesita la conexion directa a Postgres.',
      )
    }
    return new PgBossQueue({ connectionString, ...overrides })
  }

  async enqueue<T>(name: string, payload: T, opts?: EnqueueOptions): Promise<string> {
    this.#assertStarted('enqueue')
    // requireTenant() ANTES de nada: encolar sin contexto de tenant crearia un
    // job huerfano que ningun worker sabria a quien atribuir (CLAUDE.md 2.6).
    const ctx = requireTenant()
    await this.#ensureQueue(name)

    const sendOptions: SendOptions = {
      ...(opts?.retryLimit === undefined ? {} : { retryLimit: opts.retryLimit }),
      ...(opts?.retryDelaySeconds === undefined ? {} : { retryDelay: opts.retryDelaySeconds }),
      ...(opts?.retryBackoff === undefined ? {} : { retryBackoff: opts.retryBackoff }),
      ...(opts?.singletonKey === undefined ? {} : { singletonKey: opts.singletonKey }),
      ...(opts?.startAfterSeconds === undefined ? {} : { startAfter: opts.startAfterSeconds }),
      ...(opts?.expireInSeconds === undefined ? {} : { expireInSeconds: opts.expireInSeconds }),
    }

    const id = await this.#boss.send(name, buildEnvelope(ctx, payload), sendOptions)
    if (id === null) {
      // pg-boss devuelve null cuando la politica de la cola suprimio el insert.
      // Devolver un id inventado seria mentir al llamante: su job NO existe.
      //
      // OJO: con la politica por defecto de las colas que crea esta clase
      // (`standard`), pg-boss NO suprime nada por `singletonKey`, asi que hoy
      // esta rama no se alcanza. Verificado contra pg-boss 12.30.0: dos
      // `enqueue` con la misma `singletonKey` crean DOS jobs, y el test
      // "deduplicacion" de este paquete fija ese comportamiento. La supresion
      // exigiria crear la cola con politica short/singleton/stately/exclusive,
      // que esta clase no expone todavia. La comprobacion se queda porque el
      // contrato -nunca devolver un id falso- no depende de la politica.
      throw new DuplicateJobError(name, opts?.singletonKey)
    }
    return id
  }

  async process<T>(name: string, handler: JobHandler<T>, opts?: ProcessOptions): Promise<void> {
    const register = async (): Promise<void> => {
      await this.#ensureQueue(name)
      const workOptions = {
        includeMetadata: true,
        perJobResults: true,
        ...(opts?.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
        ...(opts?.pollIntervalSeconds === undefined
          ? {}
          : { pollingIntervalSeconds: opts.pollIntervalSeconds }),
      } as const
      await this.#boss.work(
        name,
        workOptions,
        async (jobs: JobWithMetadata<unknown>[]): Promise<JobResult[]> => {
          const results: JobResult[] = []
          for (const job of jobs) {
            results.push(await this.#runOne(job, handler))
          }
          return results
        },
      )
    }

    if (this.#started) {
      await register()
      return
    }
    this.#pendingWork.push({ name, register })
  }

  async schedule<T>(name: string, cron: string, payload: T, opts?: ScheduleOptions): Promise<void> {
    this.#assertStarted('schedule')
    // El tenant se congela AQUI, al programar: cada disparo del cron reproduce
    // el contexto de quien creo la programacion.
    const ctx = requireTenant()
    await this.#ensureQueue(name)
    await this.#boss.schedule(name, cron, buildEnvelope(ctx, payload), {
      ...(opts?.retryLimit === undefined ? {} : { retryLimit: opts.retryLimit }),
      ...(opts?.retryDelaySeconds === undefined ? {} : { retryDelay: opts.retryDelaySeconds }),
    })
  }

  async start(): Promise<void> {
    if (this.#stopped) {
      // `stop()` cierra el pool de pg-boss; volver a arrancar sobre esta misma
      // instancia dejaba `#pendingWork` ya vaciado y `#ensured` lleno de
      // promesas resueltas que apuntaban a una conexion cerrada: `enqueue`
      // funcionaba y los jobs se acumulaban SIN QUE NADIE LOS PROCESASE. Se
      // decide que stop() es terminal y se dice en voz alta, en vez de arrancar
      // a medias en silencio (CLAUDE.md 5).
      throw new QueueNotStartedError(
        'Esta instancia de la cola ya se paro: stop() es terminal porque cierra el pool de ' +
          'conexiones. Crea una PgBossQueue nueva en vez de reutilizar esta.',
      )
    }
    if (this.#started) {
      return
    }
    await this.#boss.start()
    this.#started = true
    // Los handlers registrados con process() antes de start() se enganchan
    // ahora: pg-boss necesita conexion para crear la cola y arrancar el worker.
    const pending = this.#pendingWork.splice(0, this.#pendingWork.length)
    for (const work of pending) {
      await work.register()
    }
  }

  /**
   * Apagado ordenado: pg-boss deja de recoger jobs nuevos y espera a que los
   * que ya estan en vuelo terminen (hasta `stopTimeoutMs`) antes de cerrar el
   * pool. Cortar un job a la mitad lo dejaria en `active` hasta que expirase.
   */
  async stop(): Promise<void> {
    if (!this.#started) {
      this.#stopped = true
      return
    }
    this.#started = false
    this.#stopped = true
    await this.#boss.stop({ graceful: true, close: true, timeout: this.#stopTimeoutMs })
  }

  /**
   * Comprobacion de vida de la cola para los endpoints de salud: pregunta a
   * Postgres si el esquema de pg-boss esta instalado. Es un viaje de ida y
   * vuelta REAL a la base de datos, no una lectura de un booleano en memoria:
   * un health check que solo mira su propia variable responde "ok" con la base
   * de datos caida.
   *
   * No forma parte de `QueuePort` a proposito: es una propiedad de ESTA
   * implementacion (pg-boss sobre Postgres), no del contrato de una cola. Quien
   * la necesite recibe una funcion, no el puerto entero.
   *
   * Los errores se propagan. Falla si la cola no esta arrancada, porque una
   * cola parada no esta sana.
   */
  async checkHealth(): Promise<void> {
    this.#assertStarted('checkHealth')
    const installed = await this.#boss.isInstalled()
    if (!installed) {
      throw new QueueNotStartedError(
        'El esquema de pg-boss no esta instalado en la base de datos: la cola no puede operar.',
      )
    }
  }

  async #runOne<T>(job: JobWithMetadata<unknown>, handler: JobHandler<T>): Promise<JobResult> {
    const base = { jobId: job.id, jobName: job.name, retryCount: job.retryCount }

    let envelope
    try {
      envelope = parseEnvelope<T>(job.data)
    } catch (error) {
      // Reintentar no va a arreglar un payload mal formado: directo a fallidos.
      this.#logger.error(
        { ...base, error: serializeError(error) },
        'Envelope de job invalido: no se procesa y va a la cola de fallidos',
      )
      return { id: job.id, status: 'deadletter', output: serializeError(error) }
    }

    const envelopeJob: JobEnvelope<T> = {
      id: job.id,
      name: job.name,
      payload: envelope.payload,
      tenantId: envelope.tenantId,
      retryCount: job.retryCount,
      createdAt: job.createdOn,
    }

    try {
      await runWithTenant(tenantContextFrom(envelope), () => handler(envelopeJob))
      return { id: job.id, status: 'completed' }
    } catch (error) {
      // No se traga: se registra con contexto completo y el job queda fallado
      // para que pg-boss lo reintente. Nunca se marca completado (CLAUDE.md 5).
      this.#logger.error(
        { ...base, tenantId: envelope.tenantId, error: serializeError(error) },
        'El handler del job lanzo: el job queda fallado',
      )
      return { id: job.id, status: 'failed', output: serializeError(error) }
    }
  }

  /**
   * Crea la cola y su cola de fallidos si no existen (idempotente en pg-boss).
   * La promesa se cachea por nombre para que N llamadas concurrentes no lancen
   * N creaciones; si falla, se descarta para poder reintentar.
   */
  #ensureQueue(name: string): Promise<void> {
    const cached = this.#ensured.get(name)
    if (cached !== undefined) {
      return cached
    }
    const creating = this.#createQueue(name).catch((error: unknown) => {
      this.#ensured.delete(name)
      throw error
    })
    this.#ensured.set(name, creating)
    return creating
  }

  async #createQueue(name: string): Promise<void> {
    if (name.endsWith(DEAD_LETTER_SUFFIX)) {
      // Una cola de fallidos no tiene cola de fallidos propia: eso seria una
      // cadena infinita. Tampoco reintenta: ya fallo todo lo que tenia que fallar.
      await this.#reconcileQueue(name, { retryLimit: 0 })
      return
    }

    const deadLetter = `${name}${DEAD_LETTER_SUFFIX}`
    // El orden importa: pg-boss exige que la cola de fallidos exista antes de
    // poder referenciarla desde la cola principal.
    await this.#reconcileQueue(deadLetter, { retryLimit: 0 })
    await this.#reconcileQueue(name, {
      retryLimit: this.#retryDefaults.retryLimit,
      retryDelay: this.#retryDefaults.retryDelaySeconds,
      retryBackoff: this.#retryDefaults.retryBackoff,
      // pg-boss rechaza retryDelayMax si retryBackoff esta apagado ("retryDelayMax
      // can only be set if retryBackoff is true"): sin backoff no hay nada que
      // topar, porque el retraso es constante.
      ...(this.#retryDefaults.retryBackoff
        ? { retryDelayMax: this.#retryDefaults.retryDelayMaxSeconds }
        : {}),
      deadLetter,
    })
  }

  /**
   * Crea la cola si no existe y, si ya existia, la deja como dice la
   * configuracion de ESTA instancia.
   *
   * LEE ESTO ANTES DE VOLVER A UN `createQueue` PELADO. El SQL de
   * `boss.createQueue` es un `INSERT ... ON CONFLICT DO NOTHING`: si la fila de
   * la cola ya existe, las opciones que se le pasan se DESCARTAN sin un solo
   * aviso. Consecuencia sobre un despliegue existente: cambiar
   * DEFAULT_RETRY_LIMIT / DEFAULT_RETRY_BACKOFF / `retryDefaults`, o anadir la
   * cola de fallidos a una cola creada sin ella, no tenia ningun efecto — y los
   * valores que quedaban eran los de pg-boss (retryLimit 2, retryDelay 0,
   * retryBackoff false, sin dead letter), con lo que los dos criterios de
   * aceptacion de T04 sobre backoff y cola de fallidos dejaban de cumplirse en
   * produccion sin que nada fallase. Los tests no lo veian porque cada uno
   * genera un nombre de cola nuevo.
   *
   * Se reconcilia en vez de fallar porque la configuracion de este fichero es
   * la fuente de verdad y aplicarla es lo que el llamante espera; la deriva se
   * registra para que quede constancia de que la cola no estaba como decia.
   */
  async #reconcileQueue(name: string, desired: DesiredQueueOptions): Promise<void> {
    await this.#boss.createQueue(name, desired)

    const actual = await this.#boss.getQueue(name)
    if (actual === null) {
      throw new QueueNotStartedError(
        `La cola "${name}" no existe despues de crearla: la base de datos no esta en el estado ` +
          'que este proceso necesita.',
      )
    }

    // Solo se miran las opciones que esta clase gobierna, no la fila entera.
    const current: { [K in keyof DesiredQueueOptions]: DesiredQueueOptions[K] | undefined } = {
      retryLimit: actual.retryLimit,
      retryDelay: actual.retryDelay,
      retryBackoff: actual.retryBackoff,
      retryDelayMax: actual.retryDelayMax,
      deadLetter: actual.deadLetter,
    }
    const keys = Object.keys(desired) as (keyof DesiredQueueOptions)[]
    // `deadLetter` ausente llega como null o como undefined segun la version;
    // se normalizan para no reportar deriva donde no la hay.
    const drift = keys.filter((key) => (current[key] ?? undefined) !== (desired[key] ?? undefined))
    if (drift.length === 0) {
      return
    }

    this.#logger.warn(
      {
        queue: name,
        deriva: drift.map((key) => ({
          opcion: key,
          enLaBaseDeDatos: current[key],
          configurado: desired[key],
        })),
      },
      'La cola ya existia con otras opciones: se aplican las de esta instancia',
    )
    await this.#boss.updateQueue(name, desired)
  }

  #assertStarted(operation: string): void {
    if (!this.#started) {
      throw new QueueNotStartedError(
        `No se puede ejecutar "${operation}" sobre una cola parada: llama a start() primero.`,
      )
    }
  }

  /** Nombre de la cola de fallidos asociada a `name`. Util para inspeccion y tests. */
  static deadLetterQueueName(name: string): string {
    return `${name}${DEAD_LETTER_SUFFIX}`
  }
}
