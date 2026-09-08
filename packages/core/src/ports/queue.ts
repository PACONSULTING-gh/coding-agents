import type { TenantId } from '../ids.js'

/**
 * Puerto de cola de trabajos (patron puertos y adaptadores). Este es el
 * contrato que packages/queue implementa sobre pg-boss, y el unico que
 * pueden importar los llamantes: asi se puede cambiar de implementacion de
 * cola sin tocar apps/webhook ni apps/worker (ver CLAUDE.md tabla de
 * arquitectura, fila "Cola de trabajos").
 *
 * IMPORTANTE para quien implemente este puerto: `process()` DEBE reestablecer
 * el contexto de tenant (`runWithTenant` de @coord/core) a partir de
 * `envelope.tenantId` ANTES de invocar el `handler`. Ningun handler de job
 * debe tener que fijar el tenant a mano.
 */
export interface JobEnvelope<T> {
  id: string
  name: string
  payload: T
  tenantId: TenantId
  retryCount: number
  createdAt: Date
}

export interface EnqueueOptions {
  retryLimit?: number
  retryDelaySeconds?: number
  retryBackoff?: boolean
  /**
   * Clave de unicidad del job.
   *
   * NO es, por si sola, un mecanismo de deduplicacion: depende de la politica
   * con la que se creo la cola, y la politica por defecto de la implementacion
   * actual (`standard`) permite varios jobs con la misma clave. Si necesitas
   * "esto se procesa una sola vez", deduplica en tu propio almacen -como hace
   * apps/webhook con la restriccion unica de `webhook_deliveries`- en vez de
   * confiar en esta opcion.
   */
  singletonKey?: string
  startAfterSeconds?: number
  /**
   * Arriendo del job: segundos que puede estar en ejecucion antes de que la
   * cola lo considere abandonado y lo vuelva a poner disponible.
   *
   * Esta es la frontera real de la garantia de entrega: la cola garantiza que
   * DOS WORKERS NO RECOGEN EL MISMO JOB A LA VEZ, no que un handler no pueda
   * re-ejecutarse. Un handler que tarde mas que su arriendo se ejecutara otra
   * vez. Por eso los handlers deben ser idempotentes, y por eso esta opcion
   * existe: un handler lento tiene que decir cuanto tarda.
   */
  expireInSeconds?: number
}

export interface ProcessOptions {
  batchSize?: number
  pollIntervalSeconds?: number
}

export interface ScheduleOptions {
  retryLimit?: number
  retryDelaySeconds?: number
}

export type JobHandler<T> = (job: JobEnvelope<T>) => Promise<void>

export interface QueuePort {
  /** Encola un job para el tenant activo (tomado de requireTenant()). Devuelve el id del job. */
  enqueue<T>(name: string, payload: T, opts?: EnqueueOptions): Promise<string>

  /** Registra un handler para los jobs con nombre `name`. */
  process<T>(name: string, handler: JobHandler<T>, opts?: ProcessOptions): Promise<void>

  /** Programa un job recurrente segun expresion cron. */
  schedule<T>(name: string, cron: string, payload: T, opts?: ScheduleOptions): Promise<void>

  /** Arranca el worker (conecta, empieza a hacer polling de los handlers registrados). */
  start(): Promise<void>

  /** Para el worker de forma ordenada. */
  stop(): Promise<void>
}
