import {
  classifyVerificationPass,
  type NotificationPort,
  type VerificationPassFacts,
} from '@coord/core'
import type { Logger } from 'pino'

import {
  resolveResponsible,
  type ResolveResponsibleDeps,
  type ResponsibleResolution,
} from './responsible.js'
import { handleVerificationOutcome, type VerificationOutcomeResult } from './verification-flow.js'

/**
 * El lazo de T06: de "esto ha pasado en una pasada de verificacion" a "la tarea
 * ha avanzado y quien responde de ella se ha enterado".
 *
 * Hasta ahora las tres piezas existian y ninguna llamaba a la siguiente:
 * `classifyVerificationPass` decide QUE modo es, `resolveResponsible` decide A
 * QUIEN, y `handleVerificationOutcome` persiste y avisa. Atarlas desde fuera
 * cada vez significa que se pueden atar mal —olvidar el motivo de "sin
 * responsable", o los criterios sin evidencia, y perder en silencio la regla
 * que devuelve la tarea a la fase de criterios—. Aqui hay un solo punto de
 * entrada que no se puede invocar a medias.
 *
 * ===========================================================================
 * ESTO NO CORRE LA VERIFICACION, LA RECOGE
 * ===========================================================================
 * Entra `facts`, no un `LlmPort`. Quien corra el gate y llame al Verifier vive
 * mas afuera, y por dos razones:
 *
 *   1. `apps/worker` no depende de `packages/agents`, y meterlo aqui obligaria
 *      a que el worker conociera el Verifier entero para poder anotar el
 *      resultado de una pasada que quiza corrio en otra maquina.
 *   2. Una pasada se puede haber corrido en CI. El resultado llega como hechos,
 *      no como una llamada que este proceso tenga que hacer.
 *
 * ===========================================================================
 * EL SEXTO CRITERIO DE T06 SE CUMPLE POR CONSTRUCCION
 * ===========================================================================
 * "Al re-verificar, el Verifier no recibe el informe del intento anterior".
 * Aqui no puede recibirlo aunque alguien quisiera: por este camino no viaja
 * ningun informe hacia el Verifier — `reportMarkdown` va HACIA el humano, en el
 * aviso, y nunca de vuelta. Y `VerificationInput` (packages/agents) no tiene
 * campo por donde meterlo: su cierre es el primer criterio de T04.
 */

export interface VerificationPassInput {
  readonly taskRef: string
  /**
   * Necesario para resolver al responsable: `claim()` solo garantiza un claim
   * vivo por sujeto DENTRO de un repo.
   */
  readonly repoId: string
  /** Que paso en la pasada. Ver `classifyVerificationPass`. */
  readonly facts: VerificationPassFacts
  /** SHA verificado, para que el aviso diga SOBRE QUE codigo se emitio. */
  readonly headSha?: string
  /** El informe de conformidad, si esta pasada llego a producir uno. */
  readonly reportMarkdown?: string
  readonly maxAttempts?: number
}

export interface VerificationPassResult extends VerificationOutcomeResult {
  /** De donde salio el responsable, o por que no salio. Util en el log. */
  readonly responsible: ResponsibleResolution
}

export async function completeVerificationPass(
  input: VerificationPassInput,
  deps: ResolveResponsibleDeps & { notifications: NotificationPort; logger: Logger },
): Promise<VerificationPassResult> {
  // 1. Que modo es. Puede lanzar: cero veredictos con el gate en verde no se
  //    clasifica como aprobado, se reporta.
  const clasificacion = classifyVerificationPass(input.facts)

  // 2. A quien le toca. Se resuelve SIEMPRE, tambien cuando la pasada fue bien:
  //    el estado guarda quien responde de la tarea, y dejarlo vacio en las
  //    pasadas buenas haria que la primera mala no supiera a quien avisar.
  const responsable = await resolveResponsible(
    { taskRef: input.taskRef, repoId: input.repoId },
    deps,
  )

  deps.logger.info(
    {
      taskRef: input.taskRef,
      outcome: clasificacion.outcome,
      responsibleSource: responsable.source,
      noEvidenceCriteria: clasificacion.noEvidenceCriteria,
    },
    clasificacion.reason,
  )

  // 3. Persistir, decidir y avisar. El motivo de "sin responsable" viaja: sin
  //    el, el aviso imprimiria la misma frase para "no hay nadie" y para "hay
  //    tres co-asignados", y una de las dos seria falsa.
  const resultado = await handleVerificationOutcome(
    {
      taskRef: input.taskRef,
      outcome: clasificacion.outcome,
      // Lo que PASO. `handleVerificationOutcome` pone lo que se hace ahora; sin
      // esto, un aviso de "no se ha gastado intento" no dice que el modelo
      // lleva dos dias negandose a contestar (issue #27).
      detail: clasificacion.reason,
      // Copia: la entrada de la capa de datos es mutable y la clasificacion es
      // `readonly`. Compartir el array dejaria que alguien lo tocara por detras.
      noEvidenceCriteria: [...clasificacion.noEvidenceCriteria],
      ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
      ...(input.reportMarkdown === undefined ? {} : { reportMarkdown: input.reportMarkdown }),
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
      ...(responsable.source === 'none'
        ? { unresolvedReason: responsable.unresolvedReason }
        : {
            responsible: responsable.responsible,
            ...(responsable.mention === undefined ? {} : { mention: responsable.mention }),
          }),
    },
    { notifications: deps.notifications, logger: deps.logger },
  )

  return { ...resultado, responsible: responsable }
}
