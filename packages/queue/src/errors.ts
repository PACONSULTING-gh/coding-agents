import { ConflictError, DomainError } from '@coord/core'

/**
 * El envelope recuperado de la cola no cumple el contrato. Es un fallo de
 * frontera de confianza: lo que hay en la tabla `job` lo escribio otro proceso
 * (posiblemente otra version del codigo, posiblemente algo que no deberia estar
 * ahi), asi que se valida antes de tocarlo (CLAUDE.md 2.4, "validacion en
 * fronteras de confianza" no es recortable).
 *
 * Un job con envelope invalido nunca se reintenta: reintentar no lo va a hacer
 * valido. Va directo a la cola de fallidos.
 */
export class InvalidJobEnvelopeError extends DomainError {
  constructor(details: string, options?: { cause?: unknown }) {
    super(`Envelope de job invalido: ${details}`, 'INVALID_JOB_ENVELOPE', options)
  }
}

/**
 * `enqueue` no llego a crear un job porque la politica de la cola suprimio el
 * insert. Se lanza en vez de devolver un id falso: el llamante tiene que
 * enterarse de que su job NO existe (CLAUDE.md 5, nada de tragarse situaciones
 * a medias).
 *
 * NO SIRVE PARA DEDUPLICAR HOY. Las colas que crea `PgBossQueue` usan la
 * politica por defecto de pg-boss (`standard`), que NO suprime jobs por
 * `singletonKey`: dos `enqueue` con la misma clave crean dos jobs y este error
 * no se lanza (verificado contra pg-boss 12.30.0; el test "deduplicacion por
 * clave de unicidad" de este paquete fija ese comportamiento). Para
 * deduplicacion de verdad -por ejemplo por GUID de entrega de webhook- se usa
 * una restriccion unica en la base de datos, como hace apps/webhook.
 *
 * La comprobacion se mantiene porque el contrato que protege -nunca devolver un
 * id que no existe- vale para cualquier politica que se anada despues.
 */
export class DuplicateJobError extends ConflictError {
  public readonly queueName: string
  public readonly singletonKey: string | undefined

  constructor(queueName: string, singletonKey: string | undefined) {
    super(
      `El job para la cola "${queueName}" no se encolo: ya hay uno con la misma clave de unicidad` +
        (singletonKey === undefined ? '' : ` (${singletonKey})`),
    )
    this.queueName = queueName
    this.singletonKey = singletonKey
  }
}

/**
 * Se ha intentado usar la cola antes de `start()` (o despues de `stop()`).
 * Es un error de ciclo de vida del proceso, no del job: se lanza en vez de
 * arrancar la conexion por sorpresa desde un `enqueue`.
 */
export class QueueNotStartedError extends DomainError {
  constructor(message: string) {
    super(message, 'QUEUE_NOT_STARTED')
  }
}
