import type { ClaimHolder } from './claims.js'
import { ValidationError } from './errors.js'

/**
 * T06 — que pasa cuando la verificacion no sale bien. Ver
 * `docs/adr/0008-flujo-de-fallo-y-ambiguedad.md`.
 *
 * ===========================================================================
 * NO HAY UN FLUJO DE FALLO. HAY CUATRO MODOS CON TRES DESTINOS.
 * ===========================================================================
 * La tarea T06 estaba escrita como si hubiera uno solo, y esa es la razon de
 * que llevara meses sin disenarse: un unico flujo obliga a elegir un
 * comportamiento que esta MAL para tres de los cuatro modos. O se castiga al
 * agente por un rechazo del modelo, o se le insiste con un criterio imposible
 * de observar, o se molesta a un humano por un fallo de lint que el agente
 * arregla solo.
 *
 * Este fichero es SOLO la decision, y es pura a proposito: no lee la base de
 * datos, no publica comentarios y no sabe que existe GitHub. Se le da el
 * estado y el resultado, y devuelve que hacer. Asi la regla —lo unico que de
 * verdad hay que revisar cuando alguien discuta el flujo— se prueba en
 * milisegundos y sin levantar nada.
 *
 * La persistencia esta en `packages/db/src/verification-flow.ts` y el cableado
 * en `apps/worker`.
 */

// ---------------------------------------------------------------------------
// Que ha pasado
// ---------------------------------------------------------------------------

/**
 * El resultado de una pasada de verificacion.
 *
 * `verifier_unavailable` NO es "el trabajo esta mal": es que no se ha podido
 * juzgar. Separarlo del resto es la mitad menos obvia de este diseno y la mas
 * importante — y no es hipotetico: hoy `claude-opus-5` rechaza la peticion del
 * Verifier con la categoria `reasoning_extraction` (issue #27).
 */
export const VERIFICATION_OUTCOMES = [
  /** El gate determinista fallo: build, lint, tipos, tests, mutacion, integridad. */
  'gate_failed',
  /** `no_apto` con al menos un FAIL: hay evidencia citada de que no cumple. */
  'verifier_fail',
  /** `no_apto` sin ningun FAIL y con al menos un SIN_EVIDENCIA. */
  'verifier_no_evidence',
  /** El Verifier no pudo emitir veredicto: negativa del modelo, timeout, sin credenciales. */
  'verifier_unavailable',
  /** `apto`. */
  'passed',
] as const
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number]

/** A donde va la tarea despues de esta pasada. */
export const FLOW_DESTINATIONS = [
  /** Se le devuelve al mismo agente, con el informe entero. */
  'same_agent',
  /** El defecto esta en el spec: se revoca la aprobacion y vuelve a la fase de criterios. */
  'criteria_phase',
  /** Se acabaron los intentos, o no se ha podido juzgar. Decide una persona. */
  'human',
  /** Apto. No hay nada que devolver. */
  'done',
] as const
export type FlowDestination = (typeof FLOW_DESTINATIONS)[number]

/**
 * Intentos del AGENTE antes de escalar. Dos, no tres.
 *
 * Si el segundo intento no ve el problema teniendo delante el informe de
 * conformidad —con la cita textual de que criterio incumple y por que—, el
 * tercero tampoco. Lo que cambia entre el intento 2 y el 3 no es la
 * informacion disponible: es solo la esperanza.
 *
 * Es una constante y no una decision por tarea a proposito: subirla el dia que
 * haya datos del piloto que lo justifiquen es cambiar este numero, y eso se ve
 * en un diff.
 */
export const DEFAULT_MAX_ATTEMPTS = 2

/**
 * Cuantas veces ha salido SIN_EVIDENCIA cada criterio, POR CRITERIO y no por
 * tarea.
 *
 * La diferencia importa: dos criterios distintos saliendo SIN_EVIDENCIA una vez
 * cada uno no son un spec ambiguo, son dos huecos de evidencia. Lo que delata
 * un criterio imposible de observar es el MISMO criterio repitiendo.
 */
export type NoEvidenceTally = Readonly<Record<string, number>>

export interface VerificationFlowState {
  /** Intentos del agente ya consumidos. */
  readonly attempts: number
  readonly noEvidenceByCriterion: NoEvidenceTally
}

export interface VerificationFlowInput {
  readonly outcome: VerificationOutcome
  readonly state: VerificationFlowState
  /**
   * Los criterios que han salido SIN_EVIDENCIA en ESTA pasada. Obligatorio (y
   * no vacio) cuando `outcome` es `verifier_no_evidence`: sin saber CUALES, no
   * se puede distinguir un spec ambiguo de un hueco de evidencia.
   */
  readonly noEvidenceCriteria?: readonly string[]
  readonly maxAttempts?: number
}

export interface VerificationFlowDecision {
  readonly destination: FlowDestination
  /** Un fallo de infraestructura NO gasta el presupuesto del agente. */
  readonly consumesAttempt: boolean
  /** `true` cuando alguien tiene que enterarse: todo lo que no vuelve al agente. */
  readonly notifiesHuman: boolean
  /** Revocar la aprobacion devuelve la tarea a `not_approved` (T01). */
  readonly revokesCriteriaApproval: boolean
  readonly attemptsAfter: number
  readonly noEvidenceByCriterionAfter: NoEvidenceTally
  /** Frase para el humano. Va tal cual al aviso: sin esto, el destino no se explica solo. */
  readonly reason: string
}

// ---------------------------------------------------------------------------
// La decision
// ---------------------------------------------------------------------------

function tallyNoEvidence(previo: NoEvidenceTally, criterios: readonly string[]): NoEvidenceTally {
  const siguiente: Record<string, number> = { ...previo }
  for (const criterio of criterios) {
    siguiente[criterio] = (siguiente[criterio] ?? 0) + 1
  }
  return siguiente
}

/** El primer criterio que ya ha salido SIN_EVIDENCIA dos veces, si lo hay. */
function criterioReiterado(tally: NoEvidenceTally): string | undefined {
  return Object.entries(tally)
    .filter(([, veces]) => veces >= 2)
    .map(([criterio]) => criterio)
    .sort()
    .at(0)
}

function assertInput(input: VerificationFlowInput, maxAttempts: number): void {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ValidationError(
      `maxAttempts tiene que ser un entero >= 1 y se recibio ${String(maxAttempts)}. Un tope de ` +
        'cero intentos no es un flujo de reintentos: es no dejar trabajar a nadie.',
    )
  }
  if (!Number.isInteger(input.state.attempts) || input.state.attempts < 0) {
    throw new ValidationError(
      `attempts tiene que ser un entero >= 0 y se recibio ${String(input.state.attempts)}.`,
    )
  }
  if (input.outcome === 'verifier_no_evidence' && (input.noEvidenceCriteria ?? []).length === 0) {
    // Es una contradiccion, no un caso borde: si el veredicto es
    // `verifier_no_evidence` tiene que haber al menos un criterio sin
    // evidencia. Tragarselo aqui haria que un spec ambiguo no se detectara
    // nunca, porque el contador por criterio no subiria jamas.
    throw new ValidationError(
      'Un resultado `verifier_no_evidence` sin `noEvidenceCriteria` es incoherente: sin saber ' +
        'que criterios quedaron sin evidencia, el contador por criterio no sube y un spec ' +
        'ambiguo no se detecta nunca.',
    )
  }
}

/**
 * Que hacer despues de una pasada de verificacion.
 *
 * El orden de las comprobaciones no es cosmetico: cuando un criterio lleva dos
 * SIN_EVIDENCIA **y** ademas se han agotado los intentos, gana la fase de
 * criterios. Escalarlo como "el agente fallo dos veces" seria un diagnostico
 * falso: el defecto esta en un criterio que nadie puede observar, y devolverselo
 * a una persona con esa etiqueta la manda a mirar el sitio equivocado.
 */
export function decideVerificationFlow(input: VerificationFlowInput): VerificationFlowDecision {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  assertInput(input, maxAttempts)

  const sinCambios = {
    attemptsAfter: input.state.attempts,
    noEvidenceByCriterionAfter: input.state.noEvidenceByCriterion,
  }

  if (input.outcome === 'passed') {
    return {
      ...sinCambios,
      destination: 'done',
      consumesAttempt: false,
      notifiesHuman: false,
      revokesCriteriaApproval: false,
      reason: 'Apto: todos los criterios en PASS.',
    }
  }

  if (input.outcome === 'verifier_unavailable') {
    // NO consume intento. Si lo consumiera, una racha de rechazos del modelo
    // escalaria todas las tareas del dia como si todos los agentes hubieran
    // fallado a la vez.
    return {
      ...sinCambios,
      destination: 'human',
      consumesAttempt: false,
      notifiesHuman: true,
      revokesCriteriaApproval: false,
      reason:
        'El Verifier no pudo emitir veredicto (negativa del modelo, timeout o falta de ' +
        'credenciales). No es trabajo mal hecho, asi que NO se ha consumido ningun intento del ' +
        'agente. Hace falta que una persona mire por que no se puede verificar.',
    }
  }

  const attemptsAfter = input.state.attempts + 1
  const agotados = attemptsAfter >= maxAttempts

  if (input.outcome === 'verifier_no_evidence') {
    const tally = tallyNoEvidence(input.state.noEvidenceByCriterion, input.noEvidenceCriteria ?? [])
    const reiterado = criterioReiterado(tally)
    if (reiterado !== undefined) {
      return {
        destination: 'criteria_phase',
        consumesAttempt: true,
        notifiesHuman: true,
        revokesCriteriaApproval: true,
        attemptsAfter,
        noEvidenceByCriterionAfter: tally,
        reason:
          `El criterio "${reiterado}" ha salido SIN_EVIDENCIA dos veces. Eso ya no es que el ` +
          'agente no dejara evidencia: es que el criterio no se puede observar. Se revoca la ' +
          'aprobacion y la tarea vuelve a la fase de criterios, no al agente.',
      }
    }
    return {
      destination: agotados ? 'human' : 'same_agent',
      consumesAttempt: true,
      notifiesHuman: agotados,
      revokesCriteriaApproval: false,
      attemptsAfter,
      noEvidenceByCriterionAfter: tally,
      reason: agotados
        ? `Quedaron criterios sin evidencia y se han agotado los ${String(maxAttempts)} intentos.`
        : 'Quedaron criterios sin evidencia. Vuelve al agente para que la deje observable; si el ' +
          'mismo criterio se repite, el problema sera del spec.',
    }
  }

  const queFallo =
    input.outcome === 'gate_failed'
      ? 'El gate determinista fallo'
      : 'El Verifier encontro al menos un criterio en FAIL'
  return {
    ...{
      attemptsAfter,
      noEvidenceByCriterionAfter: input.state.noEvidenceByCriterion,
    },
    destination: agotados ? 'human' : 'same_agent',
    consumesAttempt: true,
    notifiesHuman: agotados,
    revokesCriteriaApproval: false,
    reason: agotados
      ? `${queFallo} y se han agotado los ${String(maxAttempts)} intentos. Decide una persona.`
      : `${queFallo}. Vuelve al agente con el informe entero.`,
  }
}

// ---------------------------------------------------------------------------
// A quien se avisa
// ---------------------------------------------------------------------------

/**
 * Quien responde de la tarea.
 *
 * `undefined` es un valor legitimo y NO se disimula eligiendo a alguien
 * plausible: una tarea que falla y no tiene dueno es en si misma un hallazgo
 * que alguien tiene que ver. Inventar un destinatario convierte ese hallazgo en
 * un mensaje que se ignora por no ir con quien lo recibe.
 *
 * Hoy sale de una cadena —holder del claim activo, luego assignee del issue—
 * porque el router es el epic 03 y no existe. Cuando exista, se anade como
 * primera fuente y nada mas cambia.
 */
export type Responsible = ClaimHolder

export interface EscalationNotice {
  /** La tarea, con la misma forma que usan los criterios de aceptacion (T01). */
  readonly taskRef: string
  readonly destination: FlowDestination
  readonly reason: string
  readonly attempts: number
  readonly maxAttempts: number
  /** `undefined` cuando no se ha podido identificar a nadie. Se dice en el aviso. */
  readonly responsible?: Responsible
  /**
   * Como se menciona al responsable en el canal de destino (en GitHub, su
   * login sin la arroba).
   *
   * Lo aporta quien RESUELVE al responsable, que es el unico que sabe de donde
   * salio: un assignee de un issue es un login, y el `id` de un claim puede ser
   * cualquier cosa. Se intento adivinarlo por la forma del id y no funciona —un
   * UUID pasa por login perfectamente valido— y una mencion equivocada arrastra
   * a un tercero cualquiera a un hilo que no es suyo. Sin este campo NO se
   * menciona a nadie: se nombra por `label`, que informa igual.
   */
  readonly mention?: string
  /** El SHA verificado, para que el aviso diga SOBRE QUE codigo se emitio. */
  readonly headSha?: string
  /** El informe de conformidad en Markdown, si esta pasada llego a producir uno. */
  readonly reportMarkdown?: string
}

/**
 * Por donde sale el aviso.
 *
 * Es un puerto y no una llamada a GitHub por el mismo motivo que `QueuePort` y
 * `LlmPort`: la decision 3 del indice de pendientes —el formato de la vista de
 * estado, epic 04 T05— sigue ABIERTA. Cuando se resuelva habra que enganchar
 * otro canal, y con el puerto eso es un adaptador nuevo en vez de tocar el
 * flujo entero.
 */
export interface NotificationPort {
  notifyEscalation(notice: EscalationNotice): Promise<void>
}
