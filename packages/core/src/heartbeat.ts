import { ValidationError } from './errors.js'

/**
 * El estado de un agente derivado del TIEMPO DESDE SU ULTIMO LATIDO, y la
 * clasificacion de que esta haciendo (epic 04, T01 y T03).
 *
 * ===========================================================================
 * LA AUSENCIA DE LATIDO ES LA SEÑAL, Y NO ES UN SI/NO
 * ===========================================================================
 * El hub no puede alcanzar los portatiles: duermen, estan tras NAT y cambian de
 * red. Asi que no hay ping ni respuesta negativa; lo unico que hay es cuanto
 * hace del ultimo latido. Eso obliga a distinguir tres cosas que es MUY facil
 * juntar en una:
 *
 *   - `fresh`   — late como debe.
 *   - `stale`   — lleva un rato sin latir. NO significa que este muerto:
 *                 significa que no se sabe. Un portatil que se suspende en una
 *                 reunion de media hora pasa por aqui todos los dias.
 *   - `missing` — lleva tanto que ya no es razonable seguir esperando.
 *   - `clock_skew` — su ultimo latido esta en el FUTURO. No se sabe nada de el,
 *                 porque su reloj miente.
 *
 * El tercer criterio de aceptacion de T01 lo dice tal cual: a los 2-3 minutos
 * un agente figura como OBSOLETO, NO como muerto. Colapsar `stale` en `missing`
 * llenaria la vista de equipo de falsos muertos cada vez que alguien cierra la
 * tapa, y a la tercera vez nadie se creeria ninguno.
 */

export const AGENT_LIVENESS = ['fresh', 'stale', 'missing', 'clock_skew'] as const
export type AgentLiveness = (typeof AGENT_LIVENESS)[number]

/**
 * A partir de aqui el latido es OBSOLETO.
 *
 * El daemon empuja cada 30-60 segundos, asi que dos minutos son entre dos y
 * cuatro latidos perdidos: suficiente para no marcar obsoleto a quien tuvo un
 * hipo de red, y poco para enterarse dentro del mismo cafe.
 */
export const STALE_AFTER_MS = 120_000

/**
 * A partir de aqui ya no se espera mas.
 *
 * Quince minutos NO es "el agente ha muerto": es "esto ya no se puede seguir
 * llamando un despiste". Sigue sin ser una afirmacion sobre el proceso —puede
 * estar perfectamente vivo con el portatil cerrado— y por eso se llama
 * `missing` y no `dead`. La vista de equipo tiene que poder decir "no sabemos"
 * sin que suene a "se ha caido".
 */
export const MISSING_AFTER_MS = 900_000

export interface LivenessThresholds {
  readonly staleAfterMs?: number
  readonly missingAfterMs?: number
}

export function agentLiveness(
  lastBeatAt: Date,
  now: Date,
  thresholds: LivenessThresholds = {},
): AgentLiveness {
  const staleAfterMs = thresholds.staleAfterMs ?? STALE_AFTER_MS
  const missingAfterMs = thresholds.missingAfterMs ?? MISSING_AFTER_MS

  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1) {
    throw new ValidationError(
      `staleAfterMs tiene que ser un entero >= 1 y se recibio ${String(staleAfterMs)}.`,
    )
  }
  if (!Number.isInteger(missingAfterMs) || missingAfterMs <= staleAfterMs) {
    throw new ValidationError(
      `missingAfterMs (${String(missingAfterMs)}) tiene que ser un entero MAYOR que staleAfterMs ` +
        `(${String(staleAfterMs)}). Si fueran iguales no existiria el estado "obsoleto", y un ` +
        'portatil suspendido saltaria directo a "no sabemos nada de el".',
    )
  }

  const silencio = now.getTime() - lastBeatAt.getTime()

  // Un latido del FUTURO no se trata como fresco por casualidad: el reloj de esa
  // maquina esta mal, y creerselo esconderia un agente atascado detras de una
  // fecha que nunca envejece — el silencio saldria negativo y no cruzaria ningun
  // umbral jamas.
  //
  // Se DEVUELVE un estado y no se lanza, y eso costo un test de integracion
  // descubrirlo: lanzando, un solo agente con la hora mal tumbaba la lectura de
  // TODA la vista de equipo. Justo lo que miras cuando algo va mal es lo que
  // dejaba de funcionar. `clock_skew` es igual de ruidoso y no se lleva por
  // delante a los demas.
  if (silencio < 0) return 'clock_skew'

  if (silencio >= missingAfterMs) return 'missing'
  if (silencio >= staleAfterMs) return 'stale'
  return 'fresh'
}

/**
 * ===========================================================================
 * QUE ESTA HACIENDO EL AGENTE (T03)
 * ===========================================================================
 * El epic pide "definiciones operativas de cada etiqueta, NO interpretaciones".
 * Eso significa que la mayor parte de esta clasificacion NO necesita un modelo:
 * "la misma llamada a herramienta repetida N veces sin cambio de estado" es una
 * cuenta, no un juicio.
 *
 * Aqui esta esa parte determinista. Lo que se deja para el clasificador con
 * modelo es lo que de verdad es ambiguo, y cuando esto decide, decide: un
 * modelo no puede ablandar un STUCK que se ha contado.
 *
 * Por que importa que sea deterministico: el coste. El cuarto criterio de
 * aceptacion de T03 pide que el coste por invocacion sea despreciable, y la
 * forma mas barata de conseguirlo es no invocar nada.
 */
export const AGENT_ACTIVITIES = ['fine', 'needs_nudge', 'stuck', 'done', 'escalate'] as const
export type AgentActivity = (typeof AGENT_ACTIVITIES)[number]

/** Repeticiones de la MISMA llamada sin que cambie nada: a partir de aqui, atascado. */
export const STUCK_REPEAT_THRESHOLD = 3

/** Sin tocar un fichero durante esto, con el agente activo: merece un empujon. */
export const NUDGE_AFTER_IDLE_MS = 300_000

export interface AgentTelemetry {
  /** La ultima herramienta que llamo, o `undefined` si no ha llamado a ninguna. */
  readonly lastToolCall?: string
  /** Cuantas veces SEGUIDAS ha repetido esa misma llamada. */
  readonly repeatedToolCalls: number
  /** Cuando cambio un fichero por ultima vez. `undefined` si no ha tocado ninguno. */
  readonly lastFileChangeAt?: Date
  /** El agente dice que ha terminado. */
  readonly finished: boolean
  /** Fallos consecutivos del agente (excepciones, comandos que no arrancan). */
  readonly consecutiveFailures: number
  /** Un evento de seguridad: el agente intento algo que no debia. */
  readonly securityEvent: boolean
}

export interface ActivityInput {
  readonly telemetry: AgentTelemetry
  readonly now: Date
  readonly stuckRepeatThreshold?: number
  readonly nudgeAfterIdleMs?: number
}

export interface ActivityDecision {
  readonly activity: AgentActivity
  /** Por que. Va a la vista de equipo y al aviso, asi que lo lee una persona. */
  readonly reason: string
  /** `true` si hay que encolar un aviso para el proximo latido (T03, criterio 3). */
  readonly queuesNudge: boolean
}

export function classifyAgentActivity(input: ActivityInput): ActivityDecision {
  const { telemetry } = input
  const stuckRepeatThreshold = input.stuckRepeatThreshold ?? STUCK_REPEAT_THRESHOLD
  const nudgeAfterIdleMs = input.nudgeAfterIdleMs ?? NUDGE_AFTER_IDLE_MS

  if (!Number.isInteger(stuckRepeatThreshold) || stuckRepeatThreshold < 2) {
    throw new ValidationError(
      `stuckRepeatThreshold tiene que ser un entero >= 2 y se recibio ` +
        `${String(stuckRepeatThreshold)}. Con 1, la primera vez que un agente llama dos veces a ` +
        'la misma herramienta —que es lo normal— quedaria marcado como atascado.',
    )
  }
  if (!Number.isInteger(nudgeAfterIdleMs) || nudgeAfterIdleMs < 1) {
    throw new ValidationError(
      `nudgeAfterIdleMs tiene que ser un entero >= 1 y se recibio ${String(nudgeAfterIdleMs)}.`,
    )
  }

  // 1. Seguridad primero, y por encima incluso de "ha terminado". Un agente que
  //    intento algo que no debia y ADEMAS dice que acabo es el caso que menos
  //    conviene dejar pasar por bueno.
  if (telemetry.securityEvent) {
    return {
      activity: 'escalate',
      reason: 'Evento de seguridad: el agente intento algo que no debia. Lo mira una persona.',
      queuesNudge: false,
    }
  }

  // 2. Fallar repetido tampoco lo arregla un empujon.
  if (telemetry.consecutiveFailures >= stuckRepeatThreshold) {
    return {
      activity: 'escalate',
      reason:
        `${String(telemetry.consecutiveFailures)} fallos seguidos. Un empujon no arregla algo ` +
        'que falla siempre igual.',
      queuesNudge: false,
    }
  }

  if (telemetry.finished) {
    return { activity: 'done', reason: 'El agente declara que ha terminado.', queuesNudge: false }
  }

  // 3. ATASCADO es una CUENTA, no un juicio: la misma llamada repetida sin que
  //    cambie nada. Va antes que el empujon por inactividad porque un agente en
  //    bucle esta "activo" —hace llamadas sin parar— y por inactividad no
  //    saltaria nunca.
  if (telemetry.repeatedToolCalls >= stuckRepeatThreshold) {
    return {
      activity: 'stuck',
      reason:
        `La misma llamada (${telemetry.lastToolCall ?? 'desconocida'}) repetida ` +
        `${String(telemetry.repeatedToolCalls)} veces sin que cambie nada.`,
      queuesNudge: true,
    }
  }

  // 4. Inactividad recuperable: lleva rato sin tocar un fichero.
  const desdeElUltimoCambio =
    telemetry.lastFileChangeAt === undefined
      ? undefined
      : input.now.getTime() - telemetry.lastFileChangeAt.getTime()

  if (desdeElUltimoCambio !== undefined && desdeElUltimoCambio >= nudgeAfterIdleMs) {
    return {
      activity: 'needs_nudge',
      reason:
        `Sin tocar un fichero desde hace ${String(Math.round(desdeElUltimoCambio / 60_000))} ` +
        'minutos, y sin haber terminado.',
      queuesNudge: true,
    }
  }

  // Un agente que todavia no ha tocado NINGUN fichero no esta atascado: acaba de
  // empezar. Marcarlo por inactividad haria saltar un aviso en cada arranque.
  return { activity: 'fine', reason: 'Avanzando con normalidad.', queuesNudge: false }
}
