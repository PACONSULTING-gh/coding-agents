import { criteriaApprovalState, describeCriteriaApprovalState } from '@coord/db'
import {
  decideVerificationTrigger,
  type GithubWebhookJob,
  type VerifiableDelivery,
} from '@coord/github'
import { resolveCheckoutPath } from '@coord/graph'
import type { Logger } from 'pino'

import { runVerification, type RunVerificationDeps } from './verification-run.js'

/**
 * El disparador de la verificacion (epic 05, issue #20).
 *
 * `runVerification` sabia verificar de punta a punta y NADIE lo llamaba. Esto
 * lo engancha a un pull request.
 *
 * ===========================================================================
 * SIN CRITERIOS APROBADOS SE OMITE, Y SE DICE EN VOZ ALTA
 * ===========================================================================
 * `runVerification` LANZA si la tarea no tiene criterios aprobados, y hace bien:
 * verificar sin criterios produce un informe sobre nada. Pero aqui llegan TODOS
 * los pull requests del repositorio, y hoy casi ninguno viene de una tarea que
 * haya pasado por T01.
 *
 * Convertir eso en una excepcion por cada PR llenaria el log de errores que
 * nadie puede arreglar, y a la tercera semana nadie leeria los errores de
 * verdad. Se omite, pero a nivel `warn` y diciendo el estado exacto: "este PR
 * no paso por la fase de criterios" es un hallazgo, no ruido — solo que el
 * sitio donde se corrige es `claim()`, que es la puerta que impide empezar sin
 * ellos, y no aqui.
 *
 * ===========================================================================
 * EL CHECKOUT TIENE QUE EXISTIR
 * ===========================================================================
 * Clonar no es de esta tarea, igual que no lo era de la ingesta: si el
 * repositorio no esta en el disco, se PROPAGA. Crear el checkout aqui a
 * escondidas significaria que la primera verificacion de un repo nuevo tarda
 * varios minutos y nadie sabe por que.
 */

export type VerificationTriggerOutcome =
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'verified'; readonly taskRef: string; readonly state: string }

export interface VerificationTriggerDeps extends RunVerificationDeps {
  /** Raiz de los checkouts, `<raiz>/<owner>/<repo>`. */
  readonly checkoutRoot: string
  /** Id del repositorio en la base de datos, para resolver al responsable. */
  readonly repoId: string
  /**
   * Deja el checkout en la cabeza del PR y devuelve la ruta.
   *
   * Inyectable porque es lo unico de aqui que toca la red: un `git fetch` del
   * ref del PR. Con esto, la composicion se puede probar entera sin clonar
   * nada.
   */
  readonly prepareCheckout: (repoPath: string, delivery: VerifiableDelivery) => Promise<void>
  readonly testCommand: readonly string[]
  readonly logger: Logger
}

export async function runVerificationTrigger(
  job: GithubWebhookJob,
  deps: VerificationTriggerDeps,
): Promise<VerificationTriggerOutcome> {
  const decision = decideVerificationTrigger(job)
  if (decision.kind === 'skip') {
    deps.logger.debug(
      { deliveryId: job.deliveryId, reason: decision.reason },
      'Verificacion omitida',
    )
    return { kind: 'skipped', reason: decision.reason }
  }

  const { delivery } = decision
  const taskRef = String(delivery.number)

  const estado = await criteriaApprovalState(taskRef)
  if (estado.status !== 'approved') {
    // A `warn`, no a `debug`: que llegue una entrega de algo que nunca paso por
    // la fase de criterios es un hallazgo. Lo que no es, es un error de este
    // codigo.
    const motivo = describeCriteriaApprovalState(estado)
    deps.logger.warn({ taskRef, estado: estado.status }, `Sin verificar: ${motivo}`)
    return { kind: 'skipped', reason: `criterios_${estado.status}` }
  }

  const repoPath = resolveCheckoutPath(deps.checkoutRoot, delivery.repositoryFullName)
  await deps.prepareCheckout(repoPath, delivery)

  const resultado = await runVerification(
    {
      taskRef,
      repoId: deps.repoId,
      repoPath,
      baseRef: delivery.baseRef,
      headRef: delivery.headSha,
      testCommand: deps.testCommand,
    },
    deps,
  )

  deps.logger.info(
    { taskRef, estado: resultado.row.state, intentos: resultado.row.attempts },
    'Verificacion completada',
  )
  return { kind: 'verified', taskRef, state: resultado.row.state }
}
