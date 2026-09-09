import { DomainError } from '../errors.js'

/**
 * Puerto del modelo de lenguaje (patron puertos y adaptadores, igual que
 * `QueuePort` esconde a pg-boss).
 *
 * ===========================================================================
 * POR QUE EXISTE ESTE FICHERO. LEE ESTO ANTES DE AÑADIR NADA AQUI.
 * ===========================================================================
 * Todo el epic 05 —generar tests con un modelo distinto al que implementa
 * (T02), verificar en contexto limpio (T04), redactar el informe (T05)— habla
 * con un proveedor de LLM. Si esas piezas importaran el SDK de Anthropic
 * directamente, cambiar de proveedor, o meter un doble en un test, obligaria a
 * tocar todos los llamantes.
 *
 * Con este puerto, el proveedor es un detalle confinado a `packages/agents`:
 *
 *   - `packages/agents` implementa `LlmPort` sobre `@anthropic-ai/sdk`.
 *   - La fitness function `anthropic-sdk-solo-en-agents` (ver
 *     `.dependency-cruiser.cjs`) impide que el SDK se cuele en ningun otro
 *     paquete. Es la misma regla, y por el mismo motivo, que
 *     `pg-boss-solo-en-queue`.
 *   - Aqui NO aparece ni un tipo del SDK: `packages/core` es el dominio y no
 *     conoce infraestructura (CLAUDE.md 5, dependencias hacia dentro).
 *
 * Los nombres de este puerto son deliberadamente los del DOMINIO, no los del
 * cable: `maxOutputTokens` y no `max_tokens`, `reasoning` y no `thinking`,
 * `effort` dentro de la peticion y no dentro de un `output_config`. Traducir
 * del dominio al proveedor es trabajo del adaptador, y es exactamente el
 * trabajo que se quiere tener localizado en un solo sitio.
 */

// ---------------------------------------------------------------------------
// Peticion
// ---------------------------------------------------------------------------

/**
 * Cuanto esfuerzo de razonamiento se le pide al modelo. Es la palanca de
 * calidad/coste: el Verifier (T04) corre a `xhigh` y el generador de tests
 * (T02) a `high`.
 */
export const LLM_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type LlmEffort = (typeof LLM_EFFORT_LEVELS)[number]

/**
 * Razonamiento extendido.
 *   - `off`               — sin razonamiento extendido.
 *   - `on`                — razona, pero no devuelve resumen.
 *   - `on-with-summary`   — razona y devuelve un resumen legible en
 *                           `LlmResult.reasoningSummary`.
 *
 * Se modela como un modo y NO como un numero de tokens a proposito: el
 * presupuesto fijo de razonamiento es un detalle de un proveedor concreto (y en
 * los modelos actuales de Anthropic ya no se acepta). Un puerto que lo
 * expusiera obligaria a cambiar a todos los llamantes cuando el proveedor lo
 * retire.
 */
export const LLM_REASONING_MODES = ['off', 'on', 'on-with-summary'] as const
export type LlmReasoningMode = (typeof LLM_REASONING_MODES)[number]

export const LLM_MESSAGE_ROLES = ['user', 'assistant'] as const
export type LlmMessageRole = (typeof LLM_MESSAGE_ROLES)[number]

/**
 * Un bloque de texto del system prompt.
 *
 * `cacheBreakpoint` marca "hasta aqui, cachealo": el cache de prompt es un
 * cache de PREFIJO, asi que lo estable (instrucciones del rol, criterios de
 * aceptacion) va primero y con el corte al final, y lo volatil (el diff, la
 * salida de los tests) va despues. Se expone como una marca y no como un
 * `cache_control` del proveedor para que el llamante declare la INTENCION y no
 * el mecanismo.
 */
export interface LlmTextBlock {
  readonly text: string
  readonly cacheBreakpoint?: boolean
}

export interface LlmMessage {
  readonly role: LlmMessageRole
  readonly content: string
  readonly cacheBreakpoint?: boolean
}

/**
 * Salida estructurada: el esquema al que el proveedor debe ceñir la respuesta.
 *
 * `schema` es JSON Schema porque es lo que entienden los proveedores y lo que
 * se puede serializar; el dominio valida DESPUES lo que vuelva con su propio
 * esquema de zod. Pedir salida estructurada NO exime de validar: el resultado
 * sigue siendo texto que ha generado un modelo, es decir, una frontera de
 * confianza (CLAUDE.md 2.4).
 */
export interface LlmOutputSchema {
  /** Nombre del esquema. Algunos proveedores lo exigen y ayuda a depurar. */
  readonly name: string
  readonly description?: string
  /** JSON Schema del objeto de salida. */
  readonly schema: Readonly<Record<string, unknown>>
}

export interface LlmRequest {
  /** Identificador del modelo, tal cual lo entiende el proveedor. */
  readonly model: string
  /**
   * System prompt en bloques. En bloques y no en una cadena para poder colocar
   * el corte de cache; un solo bloque sin marca es el caso normal.
   */
  readonly system?: readonly LlmTextBlock[]
  readonly messages: readonly LlmMessage[]
  /** Tope duro de tokens de la respuesta. Obligatorio: sin techo no hay coste acotado. */
  readonly maxOutputTokens: number
  readonly effort?: LlmEffort
  readonly reasoning?: LlmReasoningMode
  readonly outputSchema?: LlmOutputSchema
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

/**
 * Por que paro el modelo.
 *
 * `refusal` NO esta en esta lista a proposito: una negativa del modelo se
 * señala lanzando `LlmRefusalError`, para que nadie pueda confundir una
 * respuesta vacia con una respuesta valida (ver mas abajo).
 */
export const LLM_STOP_REASONS = ['end_turn', 'max_output_tokens', 'other'] as const
export type LlmStopReason = (typeof LLM_STOP_REASONS)[number]

/**
 * Consumo de la llamada. Se devuelve SIEMPRE, no solo cuando alguien lo pide:
 * el coste de la verificacion es una de las cosas que hay que poder medir para
 * decidir si el epic 05 se sostiene economicamente, y un dato que no se
 * devuelve es un dato que nadie recoge.
 */
export interface LlmUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  /** Tokens de entrada servidos desde el cache de prompt. */
  readonly cacheReadInputTokens: number
  /** Tokens de entrada escritos al cache de prompt. */
  readonly cacheCreationInputTokens: number
}

export interface LlmResult {
  /** Texto concatenado de los bloques de respuesta. Vacio si solo hubo salida estructurada. */
  readonly text: string
  /**
   * El objeto que devolvio el modelo cuando se pidio `outputSchema`, ya
   * deserializado y SIN validar contra el dominio. `undefined` si no se pidio.
   */
  readonly structured: unknown
  /** Resumen del razonamiento, o `undefined` si no se pidio `on-with-summary`. */
  readonly reasoningSummary: string | undefined
  readonly stopReason: LlmStopReason
  /** Modelo que respondio de verdad. Puede no ser el pedido si el proveedor enruta. */
  readonly model: string
  readonly usage: LlmUsage
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/**
 * El modelo se nego a responder.
 *
 * Es un ERROR y no un `stopReason` a proposito. Una negativa llega con el
 * contenido vacio, y un llamante que solo mirase `text` leeria "" como si fuera
 * la respuesta: el Verifier daria por bueno un diff sin haberlo mirado. Fallar
 * ruidosamente es la unica opcion segura (CLAUDE.md 5).
 */
export class LlmRefusalError extends DomainError {
  /** Categoria que declare el proveedor, si la declara. */
  public readonly category: string | undefined
  public readonly explanation: string | undefined

  constructor(
    input: { category?: string | undefined; explanation?: string | undefined },
    options?: { cause?: unknown },
  ) {
    super(
      `El modelo se nego a responder${input.category === undefined ? '' : ` (${input.category})`}` +
        `${input.explanation === undefined ? '' : `: ${input.explanation}`}.`,
      'LLM_REFUSAL',
      options,
    )
    this.category = input.category
    this.explanation = input.explanation
  }
}

/**
 * El proveedor respondio algo que no encaja con lo pedido: salida estructurada
 * que no es JSON, respuesta sin ningun bloque utilizable, etc. No se envuelven
 * aqui los errores de transporte del proveedor (401, 429, 5xx): esos se
 * propagan tal cual, con su tipo, para que el llamante pueda distinguir lo
 * reintentable de lo que no.
 */
export class LlmProtocolError extends DomainError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'LLM_PROTOCOL', options)
  }
}

// ---------------------------------------------------------------------------
// El puerto
// ---------------------------------------------------------------------------

/**
 * Contrato que implementa `packages/agents` y el unico que pueden importar los
 * llamantes.
 *
 * Obligaciones de quien lo implemente:
 *
 *   1. Comprobar la razon de parada ANTES de leer el contenido, y lanzar
 *      `LlmRefusalError` si el modelo se nego. Nunca devolver texto vacio como
 *      si fuera una respuesta.
 *   2. Rellenar `usage` siempre, aunque el proveedor devuelva ceros.
 *   3. Propagar los errores de transporte del proveedor con su tipo original.
 *      Nada de `catch` que los convierta en `null` o en un resultado vacio.
 */
export interface LlmPort {
  complete(request: LlmRequest): Promise<LlmResult>
}
