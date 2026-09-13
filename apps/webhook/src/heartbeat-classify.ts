import { classifyAgentActivity, ValidationError, type AgentTelemetry } from '@coord/core'

/**
 * De la telemetria cruda de un latido a la decision de empujar o no (epic 04 /
 * T03, criterio 3: "dado un estado STUCK, se encola un mensaje de aviso que
 * viajara en el siguiente heartbeat").
 *
 * ===========================================================================
 * LA TELEMETRIA ES ENTRADA NO CONFIABLE
 * ===========================================================================
 * La manda el daemon, que corre en la maquina de otra persona. Lo que no tenga
 * la forma esperada se IGNORA y se sustituye por el valor neutro, en vez de
 * romper el latido: que un agente que manda basura deje de latir es perder la
 * unica señal que dice que su maquina sigue viva.
 *
 * El valor neutro nunca es el alarmante. Un campo ilegible da "no se sabe", no
 * "atascado": inventarse una alarma con datos que no se entienden es la forma
 * mas rapida de que nadie se crea las alarmas.
 */

function entero(valor: unknown): number {
  return typeof valor === 'number' && Number.isInteger(valor) && valor >= 0 ? valor : 0
}

function fecha(valor: unknown): Date | undefined {
  if (typeof valor !== 'string') return undefined
  const ms = Date.parse(valor)
  return Number.isNaN(ms) ? undefined : new Date(ms)
}

export function parseTelemetry(raw: Readonly<Record<string, unknown>>): AgentTelemetry {
  const lastToolCall = typeof raw['lastToolCall'] === 'string' ? raw['lastToolCall'] : undefined
  const lastFileChangeAt = fecha(raw['lastFileChangeAt'])

  return {
    ...(lastToolCall === undefined ? {} : { lastToolCall }),
    repeatedToolCalls: entero(raw['repeatedToolCalls']),
    ...(lastFileChangeAt === undefined ? {} : { lastFileChangeAt }),
    // `=== true` y no truthy: una cadena "false" es truthy, y darla por
    // terminada dejaria de vigilar a un agente que sigue trabajando.
    finished: raw['finished'] === true,
    consecutiveFailures: entero(raw['consecutiveFailures']),
    securityEvent: raw['securityEvent'] === true,
  }
}

/**
 * Cuanto tiene que pasar entre dos empujones al mismo agente.
 *
 * Quince minutos. El daemon late cada 45 segundos, asi que sin esto un agente
 * atascado recibiria veinte empujones en un cuarto de hora — y a la tercera vez
 * quien los lea deja de leerlos, que es exactamente el modo de fallo que la
 * vista de equipo y el gate rojo permanente comparten.
 *
 * Es un tope a cuantas veces se DECIDE molestar, no a cuantas veces llega el
 * mensaje: ver `lastCommandEnqueuedAt`.
 */
export const NUDGE_COOLDOWN_MS = 900_000

export interface NudgeDecision {
  readonly enqueue: boolean
  readonly reason: string
}

/**
 * Decide si toca empujar AHORA.
 *
 * Separado de `classifyAgentActivity` porque son dos preguntas distintas: esa
 * dice como esta el agente, y esta dice si conviene decirselo otra vez.
 */
export function decideNudge(
  telemetry: AgentTelemetry,
  lastNudgeAt: Date | undefined,
  now: Date,
  cooldownMs: number = NUDGE_COOLDOWN_MS,
): NudgeDecision {
  if (!Number.isInteger(cooldownMs) || cooldownMs < 0) {
    throw new ValidationError(
      `cooldownMs tiene que ser un entero >= 0 y se recibio ${String(cooldownMs)}.`,
    )
  }

  const decision = classifyAgentActivity({ telemetry, now })
  if (!decision.queuesNudge) {
    return { enqueue: false, reason: `Nada que empujar: ${decision.activity}.` }
  }

  if (lastNudgeAt === undefined) {
    return { enqueue: true, reason: decision.reason }
  }

  const desdeElUltimo = now.getTime() - lastNudgeAt.getTime()
  if (desdeElUltimo < cooldownMs) {
    return {
      enqueue: false,
      reason:
        `${decision.activity}, pero ya se le empujo hace ${String(Math.round(desdeElUltimo / 60_000))} ` +
        'minutos. Empujar en cada latido convierte el aviso en ruido y deja de leerse.',
    }
  }

  return { enqueue: true, reason: decision.reason }
}
