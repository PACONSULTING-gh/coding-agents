import type { JobEnvelope, QueuePort } from '@coord/core'
import {
  appendAuditEntry,
  deleteInstallation,
  updateInstallationState,
  upsertInstallation,
  withTenantConnection,
  type TenantQuery,
} from '@coord/db'
import {
  SUBSCRIBED_EVENTS,
  isSubscribedEvent,
  parseInstallationDescriptor,
  queueNameForEvent,
  type GithubWebhookJob,
  type SubscribedEvent,
} from '@coord/github'
import type { Logger } from 'pino'

/**
 * Procesadores de los eventos de webhook que encola apps/webhook.
 *
 * ---------------------------------------------------------------------------
 * ALCANCE DE T05, Y DONDE SE ENGANCHA LO QUE VENGA DESPUES
 * ---------------------------------------------------------------------------
 * Hoy cada evento hace dos cosas y ninguna mas:
 *
 *   1. Se registra en `audit_log`, DENTRO del tenant correcto. Ese registro es
 *      la persistencia del evento: es append-only y tiene API de lectura, asi
 *      que sirve de rastro sin inventar todavia un modelo de datos que aun no
 *      sabemos como sera.
 *   2. Si es un evento de `installation`, se actualiza `github_installations`.
 *
 * PUNTO DE EXTENSION: la logica de dominio de cada evento (crear tareas desde
 * issues, detectar colisiones desde pull requests, etc.) va en
 * `domainHandlers`, un mapa de evento -> funcion que hoy esta vacio a
 * proposito. Escribirla ahora seria construir sobre un dominio que todavia no
 * existe (CLAUDE.md 4, y la regla de alcance de la seccion 1). Cuando exista,
 * se anade aqui una entrada por evento y NO se toca el resto del fichero.
 */

/** Handler de dominio por evento. Recibe la transaccion del tenant ya abierta. */
export type DomainEventHandler = (tx: TenantQuery, job: GithubWebhookJob) => Promise<void>

/** Vacio a proposito: se llena desde la raiz de composicion con `registerDomainHandler`. */
export const domainHandlers: Partial<Record<string, DomainEventHandler>> = {}

/**
 * Da de alta la logica de dominio de un evento. Se llama desde la raiz de
 * composicion (`index.ts`), no desde aqui: asi este fichero no tiene que
 * conocer a los paquetes de dominio y el sentido de las dependencias se
 * mantiene.
 *
 * Registrar dos veces el mismo evento es un error de programacion —el segundo
 * pisaria al primero en silencio— y falla al arrancar, no en produccion.
 */
export function registerDomainHandler(event: SubscribedEvent, handler: DomainEventHandler): void {
  if (domainHandlers[event] !== undefined) {
    throw new Error(`Ya hay un handler de dominio registrado para el evento ${event}.`)
  }
  domainHandlers[event] = handler
}

/**
 * El payload del job viene de la tabla de la cola, que la escribio otro
 * proceso: frontera de confianza. Se comprueba antes de usarlo en vez de
 * castearlo (CLAUDE.md 2.4).
 */
function assertWebhookJob(payload: unknown): GithubWebhookJob {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('El job de webhook no es un objeto.')
  }
  const candidate = payload as Record<string, unknown>
  const deliveryId = candidate['deliveryId']
  const event = candidate['event']
  const installationId = candidate['installationId']
  const action = candidate['action']
  const eventPayload = asRecord(candidate['payload'])

  if (typeof deliveryId !== 'string' || deliveryId === '') {
    throw new Error('El job de webhook no trae deliveryId.')
  }
  if (typeof event !== 'string' || !isSubscribedEvent(event)) {
    // Un evento al que no estamos suscritos no deberia haberse encolado nunca.
    // Si aparece, el job esta mal construido: se rechaza en vez de procesarlo.
    throw new Error(`El job de webhook trae un evento no suscrito: ${JSON.stringify(event)}`)
  }
  if (typeof installationId !== 'number' || !Number.isInteger(installationId)) {
    throw new Error('El job de webhook no trae un installationId entero.')
  }
  if (eventPayload === undefined) {
    throw new Error('El job de webhook no trae payload.')
  }

  return {
    deliveryId,
    event,
    action: typeof action === 'string' ? action : null,
    installationId,
    payload: eventPayload,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Datos de contexto que hacen util una entrada de auditoria sin volcar el payload entero. */
function auditMetadata(job: GithubWebhookJob): Record<string, unknown> {
  const repository = asRecord(job.payload['repository'])?.['full_name']
  const sender = asRecord(job.payload['sender'])?.['login']
  return {
    event: job.event,
    action: job.action,
    installationId: job.installationId,
    repository: typeof repository === 'string' ? repository : null,
    sender: typeof sender === 'string' ? sender : null,
  }
}

/**
 * Aplica a `github_installations` lo que dice un evento de instalacion.
 *
 * `created` no aparece aqui: cuando GitHub lo manda, la instalacion todavia no
 * esta mapeada a ningun tenant, asi que el listener la habra respondido como
 * "unmapped" y el job no existe. Vincular una instalacion a un cliente es una
 * decision de una persona, no de un webhook (CLAUDE.md 2.1).
 */
async function applyInstallationEvent(tx: TenantQuery, job: GithubWebhookJob): Promise<void> {
  if (job.action === 'deleted') {
    await deleteInstallation(tx, job.installationId)
    return
  }

  const descriptor = parseInstallationDescriptor(job.payload)
  if (job.action === 'suspend' || job.action === 'unsuspend') {
    await updateInstallationState(tx, {
      installationId: descriptor.installationId,
      // `suspend` sin fecha en el payload no deberia ocurrir, pero si ocurre se
      // marca con la hora local: mejor una fecha aproximada que "no suspendida".
      suspendedAt: job.action === 'suspend' ? (descriptor.suspendedAt ?? new Date()) : null,
    })
    return
  }

  // Resto de acciones (`new_permissions_accepted`, cambios de repositorios):
  // se refresca la fila con lo que diga GitHub, que es la fuente de verdad.
  await upsertInstallation(tx, {
    installationId: descriptor.installationId,
    accountLogin: descriptor.accountLogin,
    accountType: descriptor.accountType,
    repositorySelection: descriptor.repositorySelection,
    suspendedAt: descriptor.suspendedAt,
  })
}

const INSTALLATION_EVENTS = new Set(['installation', 'installation_repositories'])

/**
 * Procesa un evento. Se ejecuta con el contexto de tenant ya restaurado por la
 * cola (`QueuePort.process` lo garantiza), asi que `withTenantConnection` fija
 * el tenant correcto sin que este fichero tenga que acordarse de nada.
 *
 * Todo va en UNA transaccion: o se aplica el cambio de instalacion y queda su
 * entrada de auditoria, o no queda ninguna de las dos cosas. Un fallo se
 * propaga para que la cola reintente con backoff y, agotados los intentos,
 * mande el job a la cola de fallidos.
 */
export function createGithubEventHandler(logger: Logger) {
  return async (envelope: JobEnvelope<unknown>): Promise<void> => {
    const job = assertWebhookJob(envelope.payload)

    await withTenantConnection(async (tx) => {
      if (INSTALLATION_EVENTS.has(job.event)) {
        await applyInstallationEvent(tx, job)
      }

      const domain = domainHandlers[job.event]
      if (domain !== undefined) {
        await domain(tx, job)
      }

      await appendAuditEntry(tx, {
        action: `github.webhook.${job.event}`,
        resourceType: 'github_webhook',
        resourceId: job.deliveryId,
        actorType: 'system',
        requestId: job.deliveryId,
        metadata: auditMetadata(job),
      })
    })

    logger.info(
      {
        jobId: envelope.id,
        tenantId: envelope.tenantId,
        deliveryId: job.deliveryId,
        event: job.event,
        action: job.action,
      },
      'Evento de webhook procesado',
    )
  }
}

/**
 * Registra un handler por CADA tipo de evento suscrito: una cola por evento,
 * para que un pico de `push` no bloquee los `issues`.
 */
export async function registerGithubEventHandlers(queue: QueuePort, logger: Logger): Promise<void> {
  const handler = createGithubEventHandler(logger)
  for (const event of SUBSCRIBED_EVENTS) {
    await queue.process(queueNameForEvent(event), handler)
  }
}
