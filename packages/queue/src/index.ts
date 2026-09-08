/**
 * API publica de @coord/queue.
 *
 * Todo lo que sale de aqui esta expresado en tipos de @coord/core o en tipos
 * propios de este paquete. pg-boss no asoma: ni su clase, ni sus opciones, ni
 * sus tipos de job. Cambiar de motor de cola debe ser un cambio confinado a
 * este directorio (criterio de aceptacion de T04).
 */
export {
  PgBossQueue,
  DEFAULT_QUEUE_SCHEMA,
  DEFAULT_RETRY_LIMIT,
  DEFAULT_RETRY_DELAY_SECONDS,
  DEFAULT_RETRY_BACKOFF,
  DEFAULT_RETRY_DELAY_MAX_SECONDS,
  DEFAULT_STOP_TIMEOUT_MS,
} from './pg-boss-queue.js'
export type { PgBossQueueOptions, RetryDefaults } from './pg-boss-queue.js'
export { DuplicateJobError, InvalidJobEnvelopeError, QueueNotStartedError } from './errors.js'
export { ENVELOPE_VERSION } from './envelope.js'
export type { JobPayloadEnvelope } from './envelope.js'
export { installQueueSchema, DEFAULT_RUNTIME_ROLE } from './install.js'
export type { InstallQueueSchemaOptions, InstallQueueSchemaResult } from './install.js'
export { consoleLogger } from './logger.js'
export type { QueueLogger } from './logger.js'
