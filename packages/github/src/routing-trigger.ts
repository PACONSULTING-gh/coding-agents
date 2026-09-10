import { ValidationError } from '@coord/core'

import type { GithubWebhookJob } from './events.js'

/**
 * Cuando interviene el router, y cuando NO (epic 03 / T03, issue #33).
 *
 * ===========================================================================
 * ESTO NO ES UN GATE, Y ESA ES LA DECISION DE DISEÑO
 * ===========================================================================
 * El criterio de aceptacion que mas restringe T03 dice:
 *
 *   "Dado un fallo del agente, cuando ocurre, entonces el issue sigue su curso
 *    normal y el fallo queda en el log, sin bloquear a nadie."
 *
 * Es lo CONTRARIO del epic 05, donde el fallo del Verifier bloquea el merge a
 * proposito. Aqui la sugerencia es una ayuda: si el router se cae, la gente
 * reparte el trabajo como lo repartia antes de que esto existiera. Un router
 * caido que ademas impidiera abrir issues seria un downgrade puro.
 *
 * De ahi salen las dos mitades de este fichero:
 *
 *   `decideRoutingTrigger` — PURA. Decide si toca, y cuando no toca dice por
 *     que. Sin red, sin base de datos, sin modelo: se puede probar entera.
 *   `runWithoutBlocking`  — el unico `catch` ancho del proyecto, y aqui es
 *     obligatorio. Ver su cabecera.
 *
 * ===========================================================================
 * POR QUE ESTO ES UN MODULO Y NO UN `if` EN EL HANDLER
 * ===========================================================================
 * Porque "no intervenir" tiene mas casos de los que parece, y cada uno de ellos
 * es una forma de molestar a alguien: comentar en un issue que ya tiene dueño,
 * comentar dos veces al editarlo, o comentar en un pull request creyendo que es
 * un issue. Un `if` en el handler acabaria siendo cinco `if` sin tests.
 */

/** Por que NO se dispara el routing. Cada valor es una forma distinta de molestar. */
export const ROUTING_SKIP_REASONS = [
  /** El evento no es `issues`. */
  'not_an_issue_event',
  /**
   * La accion no es `opened`. `edited`, `labeled` y `reopened` incluidos: el
   * shortlist se publica UNA VEZ, al abrirse. Comentar en cada edicion
   * convierte la ayuda en ruido, y quien edita un issue tres veces seguidas
   * mientras lo redacta no quiere tres shortlists.
   */
  'not_opened',
  /**
   * Es un pull request. La API de GitHub manda los PR por el evento
   * `pull_request`, pero el objeto `issue` de otros eventos tambien puede
   * traerlos, y un PR ya tiene autor: sugerirle asignatarios no significa nada.
   */
  'is_pull_request',
  /**
   * Ya tiene a alguien asignado. Es el criterio de aceptacion literal: "dado un
   * issue ya asignado manualmente, cuando se crea, entonces el agente no
   * interviene". Quien asigna al abrir ya ha decidido, y una sugerencia
   * encima de una decision tomada es discutirle a alguien su trabajo.
   */
  'already_assigned',
] as const
export type RoutingSkipReason = (typeof ROUTING_SKIP_REASONS)[number]

/** El issue sobre el que se va a sugerir. Lo minimo, ya validado. */
export interface RoutableIssue {
  readonly number: number
  readonly title: string
  readonly body: string | undefined
  readonly repositoryFullName: string
}

export type RoutingTrigger =
  | { readonly kind: 'route'; readonly issue: RoutableIssue }
  | { readonly kind: 'skip'; readonly reason: RoutingSkipReason }

/**
 * Decide si este evento tiene que disparar el routing.
 *
 * El payload viene de GitHub por la cola: frontera de confianza. No se castea,
 * se comprueba (CLAUDE.md 2.4). Lo que no encaje con la forma esperada lanza
 * `ValidationError` en vez de devolver `skip`: "el payload esta roto" y "este
 * issue no toca" son cosas distintas, y confundirlas haria que un cambio de
 * forma en la API de GitHub se viera como "es que nunca toca" — el routing
 * dejaria de funcionar entero y el log diria que todo va bien.
 */
export function decideRoutingTrigger(job: GithubWebhookJob): RoutingTrigger {
  if (job.event !== 'issues') return { kind: 'skip', reason: 'not_an_issue_event' }
  if (job.action !== 'opened') return { kind: 'skip', reason: 'not_opened' }

  const issue = asRecord(job.payload['issue'])
  if (issue === undefined) {
    throw new ValidationError(
      `La entrega ${job.deliveryId} es un evento "issues" con accion "opened" y no trae \`issue\`. ` +
        'O la API de GitHub ha cambiado de forma, o esto no viene de GitHub.',
    )
  }

  if (issue['pull_request'] !== undefined) return { kind: 'skip', reason: 'is_pull_request' }

  const assignees = issue['assignees']
  if (Array.isArray(assignees) && assignees.length > 0) {
    return { kind: 'skip', reason: 'already_assigned' }
  }
  // `assignee` en singular esta deprecado pero GitHub lo sigue mandando, y en
  // algunas entregas viene relleno con `assignees` vacio. Mirar solo el plural
  // haria comentar en issues que SI tienen dueño.
  if (asRecord(issue['assignee']) !== undefined) {
    return { kind: 'skip', reason: 'already_assigned' }
  }

  return { kind: 'route', issue: parseIssue(job, issue) }
}

function parseIssue(job: GithubWebhookJob, issue: Record<string, unknown>): RoutableIssue {
  const number = issue['number']
  const title = issue['title']
  // El `typeof` esta por el TIPO, no por el runtime: `Number.isInteger` ya
  // descarta cualquier cosa que no sea un numero (la cadena "77" incluida),
  // pero TypeScript no estrecha con el, asi que sin esto `number <= 0` no
  // compila. Es la razon de que el mutante que lo sustituye por `false`
  // sobreviva al mutation testing: ningun payload puede distinguirlo.
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    throw new ValidationError(
      `La entrega ${job.deliveryId} trae un issue sin numero utilizable: ${JSON.stringify(number)}.`,
    )
  }
  if (typeof title !== 'string') {
    throw new ValidationError(`La entrega ${job.deliveryId} trae un issue sin titulo.`)
  }

  const repository = asRecord(job.payload['repository'])
  const fullName = repository?.['full_name']
  if (typeof fullName !== 'string' || fullName === '') {
    throw new ValidationError(
      `La entrega ${job.deliveryId} no dice de que repositorio viene. Sin eso no se puede ni ` +
        'comentar el shortlist ni saber sobre que codigo se esta sugiriendo.',
    )
  }

  // El cuerpo vacio y el cuerpo ausente son lo mismo para quien lee: un issue
  // sin descripcion. Se normaliza aqui para que nadie tenga que acordarse de
  // que GitHub manda `null` y no `""`.
  const body = issue['body']
  return {
    number,
    title,
    body: typeof body === 'string' && body.trim() !== '' ? body : undefined,
    repositoryFullName: fullName,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

// ---------------------------------------------------------------------------
// El fallo del router no bloquea a nadie
// ---------------------------------------------------------------------------

/**
 * Ejecuta el trabajo del router de forma que su fallo NUNCA suba.
 *
 * ===========================================================================
 * SI, ES UN `catch` ANCHO. LEE ESTO ANTES DE BORRARLO O DE COPIARLO
 * ===========================================================================
 * `CLAUDE.md` §5 dice "nunca catch silencioso. Si no sabes que hacer con el
 * error, propagalo". Aqui SI se sabe que hacer con el error, y propagarlo seria
 * el fallo: el criterio de aceptacion de T03 exige que un fallo del agente deje
 * el issue seguir su curso normal sin bloquear a nadie. Si esto propagase, el
 * job del webhook fallaria, se reintentaria, y acabaria en la cola de fallidos
 * — por no haber podido sugerir un asignatario. La sugerencia es una ayuda; una
 * ayuda que rompe el flujo normal es un downgrade.
 *
 * Y no es silencioso, que es la otra mitad de la regla: `report` recibe SIEMPRE
 * el error con su tipo, y de ahi va al log y a `audit_log`. Tragar es no dejar
 * rastro; esto deja rastro y sigue.
 *
 * ESTO NO ES UNA PLANTILLA. Vale para el routing porque el routing es opcional.
 * En el epic 05 el fallo del Verifier bloquea a proposito, y envolverlo con
 * esto convertiria el gate en un adorno.
 *
 * ---------------------------------------------------------------------------
 * SI `report` TAMBIEN FALLA
 * ---------------------------------------------------------------------------
 * No se puede prometer a la vez "nunca bloquea" y "siempre queda registrado":
 * si el propio registro falla (la base de datos caida, que es justo cuando mas
 * cosas fallan), una de las dos promesas se rompe. Se elige romper la del
 * registro, porque es la que no le estropea el dia a nadie, y queda el ultimo
 * recurso de `console.error` — que en el peor caso es lo unico que habra.
 */
export async function runWithoutBlocking<T>(
  work: () => Promise<T>,
  report: (error: unknown) => void,
): Promise<T | undefined> {
  try {
    return await work()
  } catch (error: unknown) {
    try {
      report(error)
    } catch (reportingError: unknown) {
      console.error(
        '[@coord/github] el routing fallo y ADEMAS fallo al registrarlo. El original:',
        error,
        'y el del registro:',
        reportingError,
      )
    }
    return undefined
  }
}
