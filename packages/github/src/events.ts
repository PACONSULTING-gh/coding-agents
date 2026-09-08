/**
 * Eventos a los que esta suscrita la GitHub App, y como se convierten en
 * nombres de cola.
 *
 * La lista vive AQUI y en la configuracion de la App en GitHub
 * (docs/github-app-setup.md). Si se suscribe un evento nuevo en GitHub y no se
 * anade a esta lista, el listener lo respondera con 200 y lo descartara como
 * "no suscrito", que es lo correcto: mejor descartar de forma explicita y
 * visible en el log que encolar trabajo que nadie sabe procesar.
 */
export const SUBSCRIBED_EVENTS = [
  'issues',
  'issue_comment',
  'pull_request',
  'push',
  'check_run',
  'workflow_run',
  'installation',
  'installation_repositories',
] as const

export type SubscribedEvent = (typeof SUBSCRIBED_EVENTS)[number]

const SUBSCRIBED = new Set<string>(SUBSCRIBED_EVENTS)

export function isSubscribedEvent(event: string): event is SubscribedEvent {
  return SUBSCRIBED.has(event)
}

/**
 * Prefijo de las colas de webhooks. Una cola POR TIPO DE EVENTO: asi un pico
 * de `push` no retrasa los `issues`, y se puede parar el consumo de un tipo
 * concreto sin parar el resto.
 */
export const WEBHOOK_QUEUE_PREFIX = 'github.'

export function queueNameForEvent(event: SubscribedEvent): string {
  return `${WEBHOOK_QUEUE_PREFIX}${event}`
}

/** Todas las colas de webhooks, para que el worker las registre de una vez. */
export function webhookQueueNames(): string[] {
  return SUBSCRIBED_EVENTS.map(queueNameForEvent)
}

/**
 * Lo que viaja en el job. Es el contrato entre apps/webhook (que lo encola) y
 * apps/worker (que lo consume), y por eso vive en el paquete del que dependen
 * los dos.
 *
 * Se incluye el payload entero y no un extracto: extraer campos es decidir que
 * importa, y eso es trabajo del worker. El listener solo enruta (ver el
 * principio que gobierna apps/webhook).
 */
export interface GithubWebhookJob {
  /** GUID de la entrega. Sirve para correlacionar el job con `webhook_deliveries`. */
  deliveryId: string
  event: SubscribedEvent
  /** `action` del payload, si el evento la trae (`opened`, `closed`, `suspend`...). */
  action: string | null
  installationId: number
  payload: Record<string, unknown>
}
