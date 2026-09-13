import { ValidationError } from './errors.js'
import type { Claim } from './claims.js'

/**
 * Predecir que ficheros va a tocar una tarea, y avisar de con quien choca
 * (epic 04 / T04, issue #63).
 *
 * ===========================================================================
 * ESTO AVISA. NUNCA BLOQUEA. Y EL TIPO LO HACE IMPOSIBLE
 * ===========================================================================
 * El epic lo dice dos veces: "aviso, nunca bloqueando", y "con un recall por
 * debajo de 0.85 permanece como aviso y no se promociona a gate".
 *
 * Escribirlo en un comentario no basta: el dia que alguien quiera un gate
 * rapido, un booleano `puedeSeguir` en la respuesta es una invitacion. Por eso
 * aqui NO hay ninguno. Lo que se devuelve son solapamientos con su procedencia,
 * y quien quiera convertir eso en un bloqueo tiene que escribir la regla el
 * mismo — y entonces la discusion ocurre, que es justo lo que se quiere.
 *
 * La prediccion es experimental: la literatura no llega a precision de
 * produccion. Un aviso equivocado cuesta que alguien mire y siga; un bloqueo
 * equivocado cuesta que alguien no pueda trabajar y desactive el sistema.
 *
 * ===========================================================================
 * CADA FICHERO DICE POR QUE ESTA, Y SI ESTA POR DOS RAZONES, LAS DOS
 * ===========================================================================
 * Primer criterio de aceptacion. Y se guardan TODAS las procedencias, no solo
 * la mas fuerte: "esta porque lo importa el fichero de la tarea Y ADEMAS
 * cambia con el a la vez historicamente" es una prediccion mucho mas creible
 * que cualquiera de las dos sola, y quedarse con una lo esconde.
 */

/** De donde sale que un fichero este en la prediccion. */
export const PREDICTION_SOURCES = ['seed', 'import', 'call', 'cochange'] as const
export type PredictionSource = (typeof PREDICTION_SOURCES)[number]

export interface PredictionEvidence {
  readonly source: PredictionSource
  /**
   * Saltos en el grafo desde un fichero semilla. 0 para las semillas.
   * `undefined` para el co-cambio, que no es una distancia del grafo.
   */
  readonly hops?: number
  /** Con que fichero semilla se relaciona. Es lo que hace leible el "por que". */
  readonly via?: string
  /** Para co-cambio: en cuantos commits cambiaron juntos. */
  readonly together?: number
}

export interface PredictedFile {
  readonly path: string
  /** Todas las razones por las que esta. Nunca vacio. */
  readonly evidence: readonly PredictionEvidence[]
  /** En [0, 1]. Ver `confidenceFor`: se deriva, no se inventa. */
  readonly confidence: number
}

/**
 * Confianza por tipo de procedencia.
 *
 * Son PESOS ELEGIDOS, no medidos, y hay que decirlo: hasta que se mida el
 * recall contra PRs ya mergeados (tercer criterio de aceptacion) esto es una
 * ordenacion razonable y nada mas. Por eso la confianza NO se presenta nunca
 * como probabilidad.
 *
 *   - `seed`     — el fichero sale del texto de la tarea. Es lo mas firme que
 *                  hay, y aun asi no es certeza: la tarea puede nombrar un
 *                  fichero que al final no se toca.
 *   - `import`   — una arista de import de verdad, verificada en el grafo.
 *   - `call`     — una llamada. Mas debil que un import: cambiar una funcion no
 *                  obliga a tocar a quien la llama.
 *   - `cochange` — historico. El mas debil de todos y el mas util: caza las
 *                  relaciones que ninguna arista expresa (un fichero de
 *                  configuracion y el codigo que lo lee).
 */
const SOURCE_WEIGHT: Record<PredictionSource, number> = {
  seed: 1,
  import: 0.7,
  call: 0.5,
  cochange: 0.4,
}

/**
 * Cada salto de distancia en el grafo descuenta, A PARTIR DEL SEGUNDO.
 *
 * El `-1` no es un ajuste fino: sin el, una arista DIRECTA desde un fichero
 * semilla —que es `hops: 1`— ya salia descontada y quedaba por debajo de un
 * co-cambio historico. O sea, el modelo decia lo contrario de lo que dice su
 * propia documentacion: que un import pesa mas que un co-cambio.
 *
 * Lo destapo un test cuyo NOMBRE afirmaba la ordenacion correcta mientras su
 * asercion comprobaba la contraria. Pasaba en verde.
 */
const HOP_DECAY = 0.55

export function confidenceFor(evidence: readonly PredictionEvidence[]): number {
  if (evidence.length === 0) {
    throw new ValidationError(
      'Un fichero predicho sin ninguna evidencia no se puede justificar, y el primer criterio de ' +
        'aceptacion de T04 exige que cada fichero diga por que esta.',
    )
  }

  // La MAS fuerte manda, y las demas suman poco. Sumarlas todas por igual haria
  // que cinco co-cambios flojos adelantaran a un import directo, que es
  // exactamente al reves de lo que dice el grafo.
  const puntuaciones = evidence
    .map((e) => SOURCE_WEIGHT[e.source] * HOP_DECAY ** Math.max(0, (e.hops ?? 1) - 1))
    .sort((a, b) => b - a)

  const mejor = puntuaciones[0] ?? 0
  const resto = puntuaciones.slice(1).reduce((suma, valor) => suma + valor * 0.15, 0)
  return Math.min(1, Number((mejor + resto).toFixed(4)))
}

export interface MergePredictionInput {
  readonly candidates: readonly { path: string; evidence: PredictionEvidence }[]
  /** Por debajo de esto no se enseña. Ver `DEFAULT_MIN_CONFIDENCE`. */
  readonly minConfidence?: number
}

/**
 * Por debajo de esto un fichero no entra en el aviso.
 *
 * No es un umbral de calidad: es un umbral de ATENCION. Un aviso con cuarenta
 * ficheros al 0,05 no lo lee nadie, y a la tercera vez deja de leerse tambien
 * la parte buena — el mismo modo de fallo que un gate siempre rojo.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.2

/** Funde candidatos repetidos en un fichero por path, conservando TODAS sus razones. */
export function mergePredictions(input: MergePredictionInput): readonly PredictedFile[] {
  const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE
  if (!(minConfidence >= 0 && minConfidence <= 1)) {
    throw new ValidationError(
      `minConfidence tiene que estar en [0, 1] y se recibio ${String(minConfidence)}.`,
    )
  }

  const porFichero = new Map<string, PredictionEvidence[]>()
  for (const candidato of input.candidates) {
    const ruta = candidato.path.trim()
    if (ruta === '') continue
    const existentes = porFichero.get(ruta)
    if (existentes === undefined) porFichero.set(ruta, [candidato.evidence])
    else existentes.push(candidato.evidence)
  }

  return (
    [...porFichero.entries()]
      .map(([path, evidence]) => ({ path, evidence, confidence: confidenceFor(evidence) }))
      .filter((prediccion) => prediccion.confidence >= minConfidence)
      // De mas a menos confianza, y a igualdad por ruta: una prediccion que
      // cambia de orden entre dos ejecuciones identicas no se puede revisar.
      .sort((a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path))
  )
}

export interface PredictedOverlap {
  readonly path: string
  readonly confidence: number
  readonly evidence: readonly PredictionEvidence[]
  /** Quien lo tiene reclamado. */
  readonly heldBy: Claim['holder']
  readonly claimedAt: Date
}

export interface CollisionAdvisory {
  /** Los ficheros que se predicen, todos. */
  readonly predicted: readonly PredictedFile[]
  /** Los que ademas pisan un claim vivo de OTRA persona. */
  readonly overlaps: readonly PredictedOverlap[]
  /** Frase para un humano. Dice que es un aviso, siempre. */
  readonly summary: string
}

export interface CrossWithClaimsInput {
  readonly predicted: readonly PredictedFile[]
  /** Claims VIVOS. Que lo esten lo decide quien consulta, no esto. */
  readonly activeClaims: readonly Claim[]
  /** Quien va a trabajar. Sus propios claims NO son una colision. */
  readonly holderId: string
}

/**
 * Cruza la prediccion con los claims vivos.
 *
 * Devuelve solapamientos y una frase. NO devuelve ningun veredicto: ver la
 * cabecera del modulo.
 */
export function crossWithClaims(input: CrossWithClaimsInput): CollisionAdvisory {
  if (input.holderId.trim() === '') {
    throw new ValidationError(
      'crossWithClaims necesita saber QUIEN va a trabajar: sin eso, los claims propios saldrian ' +
        'como colision y el aviso diria que chocas contigo mismo.',
    )
  }

  const porRuta = new Map<string, Claim>()
  for (const claim of input.activeClaims) {
    // Solo los de FICHERO: un claim sobre el issue dice quien lleva la tarea, no
    // que ficheros toca. Contarlo como solape marcaria colision con cualquiera
    // que tenga un issue abierto.
    if (claim.subject.kind !== 'file') continue
    if (claim.holder.id === input.holderId) continue
    if (!porRuta.has(claim.subject.key)) porRuta.set(claim.subject.key, claim)
  }

  const overlaps = input.predicted.flatMap((prediccion): PredictedOverlap[] => {
    const claim = porRuta.get(prediccion.path)
    if (claim === undefined) return []
    return [
      {
        path: prediccion.path,
        confidence: prediccion.confidence,
        evidence: prediccion.evidence,
        heldBy: claim.holder,
        claimedAt: claim.claimedAt,
      },
    ]
  })

  const summary =
    overlaps.length === 0
      ? `Se predicen ${String(input.predicted.length)} fichero(s) y ninguno pisa un claim vivo de otra persona.`
      : `AVISO, no bloqueo: ${String(overlaps.length)} de ${String(input.predicted.length)} ` +
        `fichero(s) predichos los tiene reclamados otra persona (${[
          ...new Set(overlaps.map((o) => o.heldBy.label)),
        ].join(', ')}). La prediccion es experimental y puede equivocarse: mira y decide tu.`

  return { predicted: input.predicted, overlaps, summary }
}
