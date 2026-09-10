import { ValidationError } from './errors.js'

/**
 * T04 del epic 03 — si la sugerencia del router acierta lo bastante como para
 * que alguien la use en vez de ignorarla.
 *
 * Esto es la validacion del supuesto del PRD §6, y por tanto la unica pregunta
 * que decide si el epic 03 entero valia la pena. Por eso la REGLA de como se
 * cuenta vive aqui, pura y aparte de la base de datos: cuando alguien discuta
 * la cifra —y con una metrica de acierto siempre se discute— lo que hay que
 * revisar es este fichero, no una consulta SQL.
 *
 * ===========================================================================
 * CUATRO DECISIONES DE CONTEO, Y NINGUNA ES OBVIA
 * ===========================================================================
 * 1. SOLO CUENTAN LAS SUGERENCIAS YA RESUELTAS. Un issue sugerido y todavia
 *    sin asignar no es una anulacion: es que nadie ha decidido aun. Meterlo en
 *    el denominador haria que la tasa empeorase sola los viernes por la tarde.
 *
 * 2. UN `no_match` NO ES UN FALLO. Que el router diga "sin match claro" es una
 *    respuesta legitima y esperada (criterio de aceptacion de T02). Contarlo
 *    como anulacion castigaria la honestidad y empujaria el diseño hacia un
 *    router que siempre suelta un nombre, que es exactamente lo que no
 *    queremos.
 *
 * 3. NO SE ALERTA POR DEBAJO DE UNA MUESTRA MINIMA. Dos anulaciones sobre tres
 *    sugerencias dan un 67% y no significan nada. Sin este piso, la alerta
 *    salta la primera semana, nadie la cree, y a la tercera vez deja de
 *    mirarse — el mismo modo de fallo que un gate siempre rojo.
 *
 * 4. SIN DATOS LA TASA ES `undefined`, NO CERO. "0% de aciertos" y "todavia no
 *    hay nada medido" son cosas distintas, y confundirlas es como presentar
 *    una tasa de falso aprobado sin haber corrido el banco.
 */

/**
 * Una sugerencia y lo que paso con ella.
 *
 * `suggestedFirst` es el candidato del PUESTO 1, y solo ese: el criterio de
 * aceptacion pregunta por "la primera sugerencia". Si mas adelante interesa
 * medir "estaba entre los tres primeros", es otra metrica y va aparte, no un
 * ablandamiento de esta.
 */
export interface RoutingOutcomeRecord {
  readonly taskRef: string
  /** `undefined` cuando el router dijo `no_match`. */
  readonly suggestedFirst?: string
  /** `undefined` mientras nadie haya asignado el issue. */
  readonly assignedTo?: string
}

/**
 * Por debajo de esto no se alerta, se dice que no hay muestra.
 *
 * Diez no es un numero magico: es el punto en el que una tasa deja de moverse
 * entera con un solo caso. Con 3-10 personas en el equipo, alcanzarlo lleva
 * dias, no meses.
 */
export const MIN_SAMPLE_FOR_ALERT = 10

/** El umbral que fija el criterio de aceptacion: mas de la mitad anuladas. */
export const OVERRIDE_ALERT_THRESHOLD = 0.5

export interface RoutingAccuracy {
  /** Sugerencias con un candidato en el puesto 1 y ya asignadas. El denominador. */
  readonly decided: number
  /** Sugeridas y aun sin asignar. NO cuentan: nadie ha decidido todavia. */
  readonly pending: number
  /** Veces que el router dijo "sin match claro". NO son fallos. */
  readonly noMatch: number
  /** De las resueltas, cuantas se asignaron a quien iba primero. */
  readonly acceptedFirst: number
  /** `undefined` cuando `decided` es 0: no hay datos, que no es lo mismo que 0%. */
  readonly acceptanceRate: number | undefined
  readonly overrideRate: number | undefined
  /** `true` solo si hay muestra suficiente Y se supera el umbral. */
  readonly alert: boolean
  /** Frase para el humano. Explica tambien por que NO se alerta, cuando toca. */
  readonly summary: string
}

export interface RoutingAccuracyOptions {
  readonly minSample?: number
  readonly overrideThreshold?: number
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

export function summarizeRoutingAccuracy(
  records: readonly RoutingOutcomeRecord[],
  options: RoutingAccuracyOptions = {},
): RoutingAccuracy {
  const minSample = options.minSample ?? MIN_SAMPLE_FOR_ALERT
  const threshold = options.overrideThreshold ?? OVERRIDE_ALERT_THRESHOLD

  if (!Number.isInteger(minSample) || minSample < 1) {
    throw new ValidationError(
      `minSample tiene que ser un entero >= 1 y se recibio ${String(minSample)}. Una muestra ` +
        'minima de cero es no tener piso, y entonces la primera anulacion dispara la alerta.',
    )
  }
  if (!(threshold > 0 && threshold <= 1)) {
    throw new ValidationError(
      `overrideThreshold tiene que estar en (0, 1] y se recibio ${String(threshold)}.`,
    )
  }

  const noMatch = records.filter((r) => r.suggestedFirst === undefined).length
  const conSugerencia = records.filter((r) => r.suggestedFirst !== undefined)
  const resueltas = conSugerencia.filter((r) => r.assignedTo !== undefined)
  const acceptedFirst = resueltas.filter((r) => r.assignedTo === r.suggestedFirst).length

  const decided = resueltas.length
  const pending = conSugerencia.length - decided

  if (decided === 0) {
    return {
      decided,
      pending,
      noMatch,
      acceptedFirst: 0,
      acceptanceRate: undefined,
      overrideRate: undefined,
      alert: false,
      summary:
        `Sin datos: ninguna de las ${String(conSugerencia.length)} sugerencias se ha asignado ` +
        'todavia. No hay tasa que dar, que no es lo mismo que una tasa del 0%.',
    }
  }

  const acceptanceRate = acceptedFirst / decided
  const overrideRate = 1 - acceptanceRate
  const muestraSuficiente = decided >= minSample
  const superaUmbral = overrideRate > threshold

  return {
    decided,
    pending,
    noMatch,
    acceptedFirst,
    acceptanceRate,
    overrideRate,
    alert: muestraSuficiente && superaUmbral,
    summary: describir(
      { acceptedFirst, decided, acceptanceRate, overrideRate },
      {
        muestraSuficiente,
        superaUmbral,
        minSample,
        threshold,
      },
    ),
  }
}

function describir(
  cifras: {
    acceptedFirst: number
    decided: number
    acceptanceRate: number
    overrideRate: number
  },
  estado: {
    muestraSuficiente: boolean
    superaUmbral: boolean
    minSample: number
    threshold: number
  },
): string {
  const base =
    `Se acepto la primera sugerencia ${String(cifras.acceptedFirst)} de ` +
    `${String(cifras.decided)} veces (${percent(cifras.acceptanceRate)}).`

  if (!estado.muestraSuficiente) {
    // Se dice POR QUE no se alerta. Una alerta que no salta y no explica por
    // que es indistinguible de una alerta rota.
    return (
      `${base} Anulada el ${percent(cifras.overrideRate)}, pero NO se alerta: hacen falta al ` +
      `menos ${String(estado.minSample)} sugerencias resueltas y hay ${String(cifras.decided)}. ` +
      'Con esta muestra, un solo caso mueve la tasa entera.'
    )
  }
  if (!estado.superaUmbral) {
    return `${base} Anulada el ${percent(cifras.overrideRate)}, por debajo del umbral de ${percent(estado.threshold)}.`
  }
  return (
    `${base} ALERTA: se anula el ${percent(cifras.overrideRate)} de las veces, por encima del ` +
    `umbral de ${percent(estado.threshold)}. La sugerencia no esta aportando y hay que revisar ` +
    'los pesos, o documentar por que se deja como esta.'
  )
}
