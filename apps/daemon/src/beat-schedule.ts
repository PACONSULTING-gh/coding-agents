import { ValidationError } from '@coord/core'

/**
 * Cuando toca el siguiente latido (epic 04 / T02, issue #61).
 *
 * ===========================================================================
 * NO BLOQUEAR AL DESARROLLADOR ES EL REQUISITO, NO UN DETALLE
 * ===========================================================================
 * Cuarto criterio de aceptacion de T02. El daemon corre en el portatil de una
 * persona que esta trabajando: si se atasca reintentando, o se pone a latir
 * cada 200 ms porque algo falla, lo que consigue es que lo desinstalen. Y un
 * daemon desinstalado no avisa de nada.
 *
 * De ahi que todo lo de aqui sea una funcion pura que devuelve CUANTO ESPERAR:
 * el bucle no decide nada, solo espera lo que se le diga.
 *
 * ===========================================================================
 * UN TOKEN REVOCADO NO ES UN FALLO DE RED, Y ESA ES LA DISTINCION QUE IMPORTA
 * ===========================================================================
 * Las dos cosas fallan igual desde fuera —no hay latido— pero significan lo
 * contrario:
 *
 *   - Sin red, el hub no se entera de nada y hay que SEGUIR intentandolo: el
 *     portatil se suspende, el wifi se cae, se cambia de red. Reintentar con
 *     espera creciente es exactamente lo correcto.
 *   - Con el token revocado, el hub SI se entera y dice que no. Reintentar es
 *     ruido: no va a cambiar de opinion, y un daemon latiendo para siempre
 *     contra un 401 llena el log de la persona y el del servidor con algo que
 *     nadie va a arreglar mirando.
 *
 * Por eso el 401 PARA el daemon y lo dice en voz alta. Es el unico caso en el
 * que dejar de latir es la respuesta correcta.
 */

/** Cada cuanto se late cuando todo va bien. El epic pide entre 30 y 60 s. */
export const BASE_INTERVAL_MS = 45_000

/**
 * Tope de la espera entre reintentos.
 *
 * Cinco minutos: lo bastante largo para no machacar un hub caido, y lo bastante
 * corto para que un portatil que vuelve de una reunion se reincorpore en el
 * mismo cafe y no en la siguiente hora.
 */
export const MAX_BACKOFF_MS = 300_000

export type BeatOutcome =
  /** El hub lo acepto. */
  | { readonly kind: 'ok' }
  /** No se pudo ni preguntar: sin red, DNS, timeout, hub caido. */
  | { readonly kind: 'unreachable'; readonly detail: string }
  /** El hub contesto que este token no vale. NO se reintenta. */
  | { readonly kind: 'rejected'; readonly detail: string }

export interface BeatScheduleInput {
  readonly outcome: BeatOutcome
  /** Fallos seguidos ANTES de este resultado. */
  readonly consecutiveFailures: number
  readonly baseIntervalMs?: number
  readonly maxBackoffMs?: number
  /** En [0, 1). Inyectable para que el test no dependa del azar. */
  readonly jitter?: number
}

export interface BeatSchedule {
  /** Cuanto esperar. `undefined` = no volver a latir. */
  readonly waitMs: number | undefined
  /** Fallos seguidos DESPUES de este resultado. */
  readonly consecutiveFailures: number
  readonly stop: boolean
  readonly reason: string
}

export function decideNextBeat(input: BeatScheduleInput): BeatSchedule {
  const baseIntervalMs = input.baseIntervalMs ?? BASE_INTERVAL_MS
  const maxBackoffMs = input.maxBackoffMs ?? MAX_BACKOFF_MS
  const jitter = input.jitter ?? Math.random()

  if (!Number.isInteger(baseIntervalMs) || baseIntervalMs < 1_000) {
    throw new ValidationError(
      `baseIntervalMs tiene que ser un entero >= 1000 y se recibio ${String(baseIntervalMs)}. ` +
        'Latir mas de una vez por segundo no da mas informacion y si molesta a la persona que ' +
        'esta trabajando en esa maquina.',
    )
  }
  if (!Number.isInteger(maxBackoffMs) || maxBackoffMs < baseIntervalMs) {
    throw new ValidationError(
      `maxBackoffMs (${String(maxBackoffMs)}) tiene que ser un entero >= baseIntervalMs ` +
        `(${String(baseIntervalMs)}): un tope por debajo del intervalo normal haria que fallar ` +
        'saliera MAS rapido que ir bien.',
    )
  }
  if (!(jitter >= 0 && jitter < 1)) {
    throw new ValidationError(`jitter tiene que estar en [0, 1) y se recibio ${String(jitter)}.`)
  }
  if (!Number.isInteger(input.consecutiveFailures) || input.consecutiveFailures < 0) {
    throw new ValidationError(
      `consecutiveFailures tiene que ser un entero >= 0 y se recibio ` +
        `${String(input.consecutiveFailures)}.`,
    )
  }

  if (input.outcome.kind === 'rejected') {
    return {
      waitMs: undefined,
      consecutiveFailures: 0,
      stop: true,
      reason:
        `El hub rechazo el token: ${input.outcome.detail}. El daemon PARA. Reintentar no lo va ` +
        'a cambiar, y latir para siempre contra un rechazo llena dos logs con algo que nadie ' +
        'va a arreglar mirando. Da de alta el agente otra vez y vuelve a arrancar.',
    }
  }

  if (input.outcome.kind === 'ok') {
    return {
      waitMs: baseIntervalMs,
      consecutiveFailures: 0,
      stop: false,
      reason: 'Latido aceptado.',
    }
  }

  const consecutiveFailures = input.consecutiveFailures + 1

  // Espera exponencial con tope. El exponente se acota ANTES de elevar: sin
  // eso, un daemon que lleva un dia sin red calcula 2^2880 y desborda a
  // Infinity, que como espera es un daemon que no vuelve nunca.
  const pasos = Math.min(consecutiveFailures - 1, 32)
  const crudo = Math.min(baseIntervalMs * 2 ** pasos, maxBackoffMs)

  // Jitter hacia ABAJO, nunca hacia arriba: con cinco daemons que perdieron la
  // red a la vez —todos los del banco de pruebas, por ejemplo— una espera
  // identica los hace volver en bloque y tumbar el hub justo cuando se levanta.
  // Restando se reparten, y ademas nunca se supera el tope.
  const waitMs = Math.max(baseIntervalMs, Math.round(crudo * (1 - jitter * 0.5)))

  return {
    waitMs,
    consecutiveFailures,
    stop: false,
    reason:
      `No se pudo latir (${input.outcome.detail}). Fallo ${String(consecutiveFailures)} seguido; ` +
      `se reintenta en ${String(Math.round(waitMs / 1000))} s. El trabajo de la persona no se ` +
      'toca.',
  }
}
