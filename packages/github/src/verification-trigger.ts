import { ValidationError } from '@coord/core'

import type { GithubWebhookJob } from './events.js'

/**
 * Decide si un evento de pull request tiene que disparar una verificacion
 * (epic 05, issue #20).
 *
 * Mismo patron que `decideRoutingTrigger` y por los mismos motivos: el payload
 * viene de GitHub por la cola, o sea frontera de confianza, y lo que no encaja
 * con la forma esperada LANZA en vez de devolver `skip`. "El payload esta roto"
 * y "este PR no toca" son cosas distintas, y confundirlas haria que un cambio
 * de forma en la API se viera como "es que nunca toca": la verificacion dejaria
 * de funcionar entera y el log diria que todo va bien.
 */

export const VERIFICATION_SKIP_REASONS = [
  'not_a_pull_request_event',
  /**
   * La accion no entrega nada nuevo. `opened`, `synchronize` y `reopened` si:
   * son las tres en las que hay codigo que juzgar. `labeled`, `edited` o
   * `assigned` no cambian ni una linea, y verificar otra vez gastaria una
   * llamada cara para llegar al mismo veredicto.
   */
  'not_a_delivery',
  /**
   * Es un borrador. Un draft es trabajo que su autor dice que NO esta listo;
   * verificarlo produce un "no apto" merecido y completamente inutil, y ademas
   * le gasta un intento de los dos que tiene.
   */
  'draft',
  /** Ya esta cerrado o mergeado: verificar ahora no cambia nada de lo que pase. */
  'closed',
] as const
export type VerificationSkipReason = (typeof VERIFICATION_SKIP_REASONS)[number]

/** La entrega que hay que verificar. Lo minimo, ya validado. */
export interface VerifiableDelivery {
  /** Numero del PR. Es tambien el `task_ref` del flujo: un PR resuelve un issue. */
  readonly number: number
  /** SHA de la cabeza. Es lo que se verifica, y lo que va en el informe. */
  readonly headSha: string
  /** Rama contra la que se entrega, normalmente `main`. */
  readonly baseRef: string
  readonly repositoryFullName: string
}

export type VerificationTrigger =
  | { readonly kind: 'verify'; readonly delivery: VerifiableDelivery }
  | { readonly kind: 'skip'; readonly reason: VerificationSkipReason }

const DELIVERY_ACTIONS = new Set(['opened', 'synchronize', 'reopened'])
const SHA_PATTERN = /^[0-9a-f]{40}$/

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function decideVerificationTrigger(job: GithubWebhookJob): VerificationTrigger {
  if (job.event !== 'pull_request') return { kind: 'skip', reason: 'not_a_pull_request_event' }
  // `action` puede venir null: no todos los eventos la traen.
  if (job.action === undefined || job.action === null || !DELIVERY_ACTIONS.has(job.action)) {
    return { kind: 'skip', reason: 'not_a_delivery' }
  }

  const pr = asRecord(job.payload['pull_request'])
  if (pr === undefined) {
    throw new ValidationError(
      `La entrega ${job.deliveryId} es un evento "pull_request" con accion "${job.action}" y no ` +
        'trae `pull_request`. O la API de GitHub ha cambiado de forma, o esto no viene de GitHub.',
    )
  }

  if (pr['draft'] === true) return { kind: 'skip', reason: 'draft' }
  if (pr['state'] === 'closed') return { kind: 'skip', reason: 'closed' }

  const numero = pr['number']
  if (typeof numero !== 'number' || !Number.isInteger(numero) || numero <= 0) {
    throw new ValidationError(
      `La entrega ${job.deliveryId} trae un numero de PR que no es un entero positivo.`,
    )
  }

  const head = asRecord(pr['head'])
  const headSha = head?.['sha']
  if (typeof headSha !== 'string' || !SHA_PATTERN.test(headSha)) {
    // Sin SHA completo no se puede decir SOBRE QUE codigo se emitio el informe,
    // y un informe que no dice a que se refiere sirve para aprobar cualquier
    // cosa. No se acepta un sha corto: el informe lo cita entero.
    throw new ValidationError(
      `La entrega ${job.deliveryId} no trae un SHA de cabeza completo (40 hex). Sin el, el ` +
        'informe de conformidad no podria decir sobre que codigo se emitio.',
    )
  }

  const base = asRecord(pr['base'])
  const baseRef = base?.['ref']
  if (typeof baseRef !== 'string' || baseRef.trim() === '') {
    throw new ValidationError(
      `La entrega ${job.deliveryId} no trae la rama base. Sin ella no se puede calcular que ` +
        'cambia esta entrega respecto a lo que ya estaba.',
    )
  }

  const repositorio = asRecord(job.payload['repository'])
  const fullName = repositorio?.['full_name']
  if (typeof fullName !== 'string' || fullName.trim() === '') {
    throw new ValidationError(`La entrega ${job.deliveryId} no trae el repositorio.`)
  }

  return {
    kind: 'verify',
    delivery: {
      number: numero,
      headSha,
      baseRef: baseRef.trim(),
      repositoryFullName: fullName.trim(),
    },
  }
}
