import {
  LlmProtocolError,
  LlmRefusalError,
  ValidationError,
  type LlmPort,
  type NotificationPort,
  type VerificationPassFacts,
} from '@coord/core'
import {
  buildConformanceReport,
  renderConformanceReportMarkdown,
  verifyChanges,
  type TraceableCriterion,
  type VerificationResult,
} from '@coord/agents'
import { criteriaApprovalState, describeCriteriaApprovalState, readCriteria } from '@coord/db'
import type { Logger } from 'pino'

import { readDelivery, type Delivery, type DeliveryRequest } from './delivery.js'
import type { ResolveResponsibleDeps } from './responsible.js'
import { completeVerificationPass, type VerificationPassResult } from './verification-pass.js'

/**
 * Una pasada de verificacion ENTERA, de un repositorio git a un estado nuevo en
 * la base de datos y un aviso al responsable.
 *
 * Es la raiz que ata las cinco piezas que hasta ahora no se llamaban entre si:
 *
 *     criterios aprobados (T01)  ->  packages/db
 *     entrega (diff + tests)     ->  delivery.ts
 *     gate determinista (T03)    ->  aqui, ver el limite de abajo
 *     Verifier en aislamiento    ->  packages/agents
 *     clasificar y avanzar (T06) ->  verification-pass.ts
 *
 * ===========================================================================
 * QUE PARTE DEL GATE CORRE AQUI, Y CUAL NO
 * ===========================================================================
 * Corre la mitad que se puede correr sin mas contexto: **los tests tienen que
 * pasar**. Un codigo de salida distinto de cero es `gate_failed` y ni se le
 * pregunta al Verifier, porque gastar una llamada cara para que diga lo que el
 * gate ya dijo es tirar dinero.
 *
 * NO corre la auditoria de manipulacion de tests generados
 * (`verifyAndRecordGeneratedTests`, T03). Esa necesita el manifiesto firmado en
 * el arbol, y una entrega que todavia no ha pasado por el generador de tests
 * (T02) no lo tiene. Se dice aqui en vez de dejar creer que el gate esta
 * completo: **una entrega verificada por este camino NO ha sido auditada contra
 * manipulacion de tests**, y hasta que se enganche eso, el `passed` que salga de
 * aqui es mas debil de lo que T03 promete.
 *
 * ===========================================================================
 * EL VERIFIER NO RECIBE NADA MAS QUE EL SPEC Y EL DIFF
 * ===========================================================================
 * Es el primer criterio de aceptacion de T04 y aqui se cumple por construccion:
 * `VerificationInput` se monta con los criterios leidos de la base de datos y
 * la entrega leida de git, y no hay ninguna via por la que pueda entrar el
 * informe de un intento anterior. Tampoco se le pasa quien es el responsable ni
 * cuantos intentos lleva la tarea: eso se resuelve DESPUES del veredicto.
 */

export interface RunVerificationInput {
  readonly taskRef: string
  /** Para resolver al responsable: un claim vivo solo es unico dentro de un repo. */
  readonly repoId: string
  readonly repoPath: string
  readonly baseRef: string
  readonly headRef: string
  readonly testCommand: readonly string[]
  readonly maxAttempts?: number
  readonly maxDiffBytes?: number
}

export interface RunVerificationDeps extends ResolveResponsibleDeps {
  readonly llm: LlmPort
  readonly notifications: NotificationPort
  readonly logger: Logger
  /** Inyectable para poder probar la composicion sin un repo de verdad. */
  readonly readDelivery?: (request: DeliveryRequest) => Promise<Delivery>
}

export interface RunVerificationResult extends VerificationPassResult {
  /** `undefined` cuando el gate corto antes de llamar al Verifier. */
  readonly verification?: VerificationResult
}

/**
 * Los criterios, en la forma que espera el Verifier.
 *
 * `id` es el uuid de la fila y no el ordinal: es lo que hace que un veredicto
 * sea trazable hasta el criterio exacto aunque alguien reordene la lista.
 */
function comoCriteriosTrazables(
  criteria: readonly { id: string; ordinal: number; given: string; when: string; then: string }[],
): TraceableCriterion[] {
  return criteria.map((row) => ({
    id: row.id,
    ordinal: row.ordinal,
    given: row.given,
    when: row.when,
    then: row.then,
  }))
}

export async function runVerification(
  input: RunVerificationInput,
  deps: RunVerificationDeps,
): Promise<RunVerificationResult> {
  const leerEntrega = deps.readDelivery ?? readDelivery

  // --- Precondicion, no modo de fallo -------------------------------------
  // Verificar sin criterios aprobados no da "no apto": no da NADA. No hay
  // contra que contrastar el diff, y un informe sin criterios se leeria como
  // una aprobacion. Se lanza en vez de inventar un desenlace.
  const estado = await criteriaApprovalState(input.taskRef)
  if (estado.status !== 'approved') {
    throw new ValidationError(
      `No se puede verificar ${input.taskRef}: ${describeCriteriaApprovalState(estado)} ` +
        'Verificar sin criterios aprobados no produce un "no apto", produce un informe sobre ' +
        'nada, y ese informe sirve para aprobar un merge.',
    )
  }

  const { criteria } = await readCriteria(input.taskRef)

  // --- La entrega ----------------------------------------------------------
  // Sus fallos son del AGENTE, no del Verifier: una entrega vacia o un diff que
  // no cabe son trabajo mal hecho, asi que van a `gate_failed` —vuelven al
  // agente y le gastan un intento— y no a `verifier_unavailable`.
  let entrega: Delivery
  try {
    entrega = await leerEntrega({
      repoPath: input.repoPath,
      baseRef: input.baseRef,
      headRef: input.headRef,
      testCommand: input.testCommand,
      ...(input.maxDiffBytes === undefined ? {} : { maxDiffBytes: input.maxDiffBytes }),
    })
  } catch (error) {
    if (error instanceof ValidationError) {
      return completar(input, deps, { gate: 'failed', detail: error.message })
    }
    // Cualquier otra cosa —git no esta, la ruta no existe, el comando de tests
    // no arranca— NO es trabajo mal hecho del agente. Se propaga con su tipo en
    // vez de cobrarle un intento por una averia nuestra.
    throw error
  }

  // --- El gate determinista (la mitad que corre aqui) ----------------------
  if (entrega.testRun.exitCode !== 0) {
    return completar(
      input,
      deps,
      {
        gate: 'failed',
        detail:
          `\`${entrega.testRun.command}\` termino con codigo ` +
          `${String(entrega.testRun.exitCode)}. No se llama al Verifier: gastar una llamada para ` +
          'que diga lo que el gate ya ha dicho es tirar dinero.',
      },
      entrega.headSha,
    )
  }

  // --- El Verifier ---------------------------------------------------------
  let resultado: VerificationResult
  try {
    resultado = await verifyChanges(deps.llm, {
      taskRef: input.taskRef,
      criteria: comoCriteriosTrazables(criteria),
      artifact: { headSha: entrega.headSha, baseSha: entrega.baseSha },
      diff: entrega.diff,
      testRun: entrega.testRun,
    })
  } catch (error) {
    // Las tres formas de NO tener veredicto. Ninguna es trabajo mal hecho del
    // agente, asi que ninguna le gasta un intento (ADR 0008, decision 1):
    //   - el modelo se nego (issue #27, y se ha visto que NO es determinista)
    //   - la respuesta no encaja con lo pedido
    //   - el informe se rechazo porque una cita no era literal
    if (
      error instanceof LlmRefusalError ||
      error instanceof LlmProtocolError ||
      error instanceof ValidationError
    ) {
      return completar(
        input,
        deps,
        { gate: 'passed', verifier: { kind: 'unavailable', detail: error.message } },
        entrega.headSha,
      )
    }
    throw error
  }

  const informe = buildConformanceReport(resultado)
  const renderizado = renderConformanceReportMarkdown(informe)
  if (!renderizado.fitsOnScreen) {
    // El tercer criterio de aceptacion de T05 dice que el informe cabe en una
    // pantalla. Que no quepa NO se oculta: el renderizador ya ha compactado
    // todo lo que sabe, asi que esto significa que la tarea tiene demasiados
    // criterios para un solo informe.
    deps.logger.warn(
      {
        taskRef: input.taskRef,
        lineas: renderizado.lineCount,
        caracteres: renderizado.charCount,
        compactacion: renderizado.compactionLevel,
      },
      'El informe de conformidad NO cabe en una pantalla ni compactado. Se publica igual, pero ' +
        'quien lo lea va a hacer scroll, que es justo lo que T05 queria evitar.',
    )
  }
  const markdown = renderizado.text

  const pasada = await completar(
    input,
    deps,
    {
      gate: 'passed',
      verifier: {
        kind: 'verdicts',
        verdicts: resultado.verdicts.map((veredicto) => ({
          criterionId: veredicto.criterionId,
          verdict: veredicto.verdict,
        })),
      },
    },
    entrega.headSha,
    markdown,
  )

  return { ...pasada, verification: resultado }
}

async function completar(
  input: RunVerificationInput,
  deps: RunVerificationDeps,
  facts: VerificationPassFacts,
  headSha?: string,
  reportMarkdown?: string,
): Promise<VerificationPassResult> {
  return completeVerificationPass(
    {
      taskRef: input.taskRef,
      repoId: input.repoId,
      facts,
      ...(headSha === undefined ? {} : { headSha }),
      ...(reportMarkdown === undefined ? {} : { reportMarkdown }),
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    },
    deps,
  )
}
