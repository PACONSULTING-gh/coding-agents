import {
  LlmProtocolError,
  LlmRefusalError,
  ValidationError,
  type LlmPort,
  type LlmRequest,
  type LlmResult,
  type LlmStopReason,
  type LlmTextBlock,
} from '@coord/core'
import Anthropic from '@anthropic-ai/sdk'

/**
 * Implementacion de `LlmPort` sobre `@anthropic-ai/sdk`.
 *
 * ===========================================================================
 * ESTE FICHERO NO SE HA EJERCITADO CONTRA LA API DE VERDAD. LEELO ANTES DE
 * FIARTE DE EL.
 * ===========================================================================
 * En la maquina donde se escribio no hay credenciales de Anthropic, asi que
 * NUNCA se ha hecho una llamada real. Lo que si esta probado
 * (`test/anthropic-llm.test.ts`) es el camino completo hasta el cable —
 * construir la peticion, mandarla por HTTP, leer el stream de respuesta,
 * traducirla al dominio — contra un servidor HTTP local que habla el protocolo
 * de eventos de la API. Eso cubre la traduccion, que es donde estan los errores
 * de este fichero; no cubre que el contrato del servidor real sea el que aqui
 * se supone.
 *
 * Concretamente, "los tests estan en verde" NO significa "probado contra
 * Claude". La primera llamada real puede devolver un 400 por una forma que aqui
 * se de por buena. Cuando haya credenciales, el primer trabajo es una llamada
 * de humo contra la API viva.
 *
 * ---------------------------------------------------------------------------
 * FORMAS DE LA API QUE CAMBIARON EN 2025-2026 Y AQUI SE RESPETAN
 * ---------------------------------------------------------------------------
 * (Del contrato oficial cargado al escribir esto. Si tu memoria dice otra cosa,
 * tu memoria esta desfasada; comprueba antes de "arreglar" nada de esto.)
 *
 *   - Los ids de modelo NO llevan sufijo de fecha: `claude-opus-5`.
 *   - `thinking: { type: 'adaptive' }`. `budget_tokens` da 400.
 *   - El esfuerzo va DENTRO de `output_config`, no en el nivel superior.
 *   - La salida estructurada es `output_config.format`; `output_format` esta
 *     deprecado.
 *   - El prefill del turno `assistant` esta ELIMINADO y da 400. Por eso el
 *     formato se fuerza con salida estructurada o desde el system prompt, y
 *     este adaptador rechaza una peticion que termine en `assistant` en vez de
 *     mandarla y comerse el 400.
 *   - `stop_reason: 'refusal'` existe: se comprueba ANTES de leer `content`.
 */

/** Modelos que usa el epic 05. Se exportan para no repartir cadenas sueltas por el codigo. */
export const VERIFIER_MODEL = 'claude-opus-5'
export const TEST_GENERATOR_MODEL = 'claude-sonnet-5'

export interface AnthropicLlmConfig {
  /**
   * Clave de API. Se pasa SIEMPRE explicitamente y no se deja que el SDK la
   * busque por su cuenta: un cliente que resuelve credenciales solo puede
   * acabar llamando a la API de verdad desde un test que creia estar hablando
   * con un doble. La clave sale de la configuracion del proceso; en el
   * repositorio no hay ninguna (CLAUDE.md 5).
   */
  readonly apiKey: string
  /** Base de la API. Se sobreescribe en los tests para apuntar al doble local. */
  readonly baseURL?: string
  /** Milisegundos. El SDK cuenta en milisegundos, no en segundos. */
  readonly timeoutMs?: number
  readonly maxRetries?: number
}

/** 10 minutos: el Verifier a `xhigh` sobre un diff grande tarda. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Traduce las razones de parada del proveedor al vocabulario del puerto.
 * `refusal` no aparece aqui: se trata antes, lanzando.
 */
function toStopReason(stopReason: Anthropic.StopReason | null): LlmStopReason {
  switch (stopReason) {
    case 'end_turn':
      return 'end_turn'
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_output_tokens'
    default:
      return 'other'
  }
}

const EPHEMERAL: Anthropic.CacheControlEphemeral = { type: 'ephemeral' }

function toSystemBlocks(blocks: readonly LlmTextBlock[]): Anthropic.TextBlockParam[] {
  return blocks.map((block) =>
    block.cacheBreakpoint === true
      ? { type: 'text', text: block.text, cache_control: EPHEMERAL }
      : { type: 'text', text: block.text },
  )
}

function toMessages(request: LlmRequest): Anthropic.MessageParam[] {
  return request.messages.map((message) => ({
    role: message.role,
    // El contenido va como bloque cuando hay que marcar el corte de cache
    // (`cache_control` vive en el bloque, no en el mensaje) y como cadena
    // cuando no, que es lo que la API espera en el caso normal.
    content:
      message.cacheBreakpoint === true
        ? [{ type: 'text' as const, text: message.content, cache_control: EPHEMERAL }]
        : message.content,
  }))
}

/**
 * `JSONOutputFormat` de la API solo lleva `type` y `schema`: no tiene campos
 * para el nombre ni la descripcion del esquema. El puerto si los tiene, porque
 * otros proveedores los exigen, asi que aqui se doblan sobre las palabras clave
 * estandar de JSON Schema (`title` / `description`) en vez de tirarlos — y sin
 * pisar lo que el esquema ya diga.
 */
function toOutputFormat(request: LlmRequest): Anthropic.JSONOutputFormat | undefined {
  const output = request.outputSchema
  if (output === undefined) return undefined
  const schema: Record<string, unknown> = { ...output.schema }
  schema['title'] ??= output.name
  if (output.description !== undefined) {
    schema['description'] ??= output.description
  }
  return { type: 'json_schema', schema }
}

function toThinking(request: LlmRequest): Anthropic.ThinkingConfigParam | undefined {
  switch (request.reasoning) {
    case undefined:
      return undefined
    case 'on':
      return { type: 'adaptive', display: 'omitted' }
    case 'on-with-summary':
      return { type: 'adaptive', display: 'summarized' }
    case 'off':
      // Regla del proveedor, no del dominio: en Opus 5 desactivar el
      // razonamiento con esfuerzo `xhigh` o `max` devuelve 400. Se rechaza aqui
      // con un mensaje que dice que hacer, en vez de mandar la peticion y
      // traducir despues un 400 que no explica nada.
      if (request.effort === 'xhigh' || request.effort === 'max') {
        throw new ValidationError(
          `El proveedor rechaza desactivar el razonamiento con esfuerzo "${request.effort}". ` +
            'Si quieres gastar menos, baja el esfuerzo (low/medium) y deja el razonamiento ' +
            'activado; sale mas barato y mejor.',
        )
      }
      return { type: 'disabled' }
  }
}

export function buildMessageParams(request: LlmRequest): Anthropic.MessageStreamParams {
  const last = request.messages.at(-1)
  if (last === undefined) {
    throw new ValidationError('Una peticion al modelo necesita al menos un mensaje.')
  }
  if (last.role === 'assistant') {
    // El prefill del turno assistant esta eliminado en los modelos actuales y
    // devuelve 400. Se rechaza aqui, con la alternativa, en vez de gastar una
    // llamada para recibir un error del servidor.
    throw new ValidationError(
      'El ultimo mensaje no puede ser del `assistant`: el prefill esta eliminado en los ' +
        'modelos actuales y la API devuelve 400. Para forzar el formato usa `outputSchema` o ' +
        'una instruccion en el system prompt.',
    )
  }

  const format = toOutputFormat(request)
  const outputConfig: Anthropic.OutputConfig = {}
  if (request.effort !== undefined) outputConfig.effort = request.effort
  if (format !== undefined) outputConfig.format = format

  const params: Anthropic.MessageStreamParams = {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    messages: toMessages(request),
  }
  if (request.system !== undefined && request.system.length > 0) {
    params.system = toSystemBlocks(request.system)
  }
  if (Object.keys(outputConfig).length > 0) {
    params.output_config = outputConfig
  }
  const thinking = toThinking(request)
  if (thinking !== undefined) {
    params.thinking = thinking
  }
  return params
}

/**
 * Traduce la respuesta del proveedor al resultado del dominio.
 *
 * Se comprueba `stop_reason` ANTES de tocar `content`: una negativa llega con
 * el contenido vacio, y leerlo como si fuera una respuesta es exactamente el
 * fallo que el puerto prohibe.
 */
export function toLlmResult(message: Anthropic.Message, request: LlmRequest): LlmResult {
  if (message.stop_reason === 'refusal') {
    // `stop_details` solo esta poblado en este caso, y aun asi puede venir a
    // null: se lee con cuidado en vez de darlo por hecho.
    const details = message.stop_details
    throw new LlmRefusalError({
      category: details?.category ?? undefined,
      explanation: details?.explanation ?? undefined,
    })
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')

  const thinking = message.content
    .filter((block): block is Anthropic.ThinkingBlock => block.type === 'thinking')
    .map((block) => block.thinking)
    .filter((summary) => summary !== '')
    .join('\n')

  let structured: unknown
  if (request.outputSchema !== undefined) {
    if (text.trim() === '') {
      throw new LlmProtocolError(
        `Se pidio salida estructurada ("${request.outputSchema.name}") y el modelo no devolvio ` +
          `ningun texto (stop_reason=${message.stop_reason ?? 'null'}).`,
      )
    }
    try {
      structured = JSON.parse(text)
    } catch (error) {
      // La causa viaja entera. No se devuelve `undefined` "para seguir": quien
      // pidio salida estructurada la necesita, y un undefined silencioso
      // acabaria como un veredicto vacio en el informe de conformidad.
      throw new LlmProtocolError(
        `Se pidio salida estructurada ("${request.outputSchema.name}") y la respuesta no es ` +
          'JSON valido.',
        { cause: error },
      )
    }
  }

  return {
    text,
    structured,
    reasoningSummary: thinking === '' ? undefined : thinking,
    stopReason: toStopReason(message.stop_reason),
    model: message.model,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
  }
}

/**
 * El adaptador. Todo lo que sabe de Anthropic el resto del sistema esta aqui
 * dentro; la fitness function `anthropic-sdk-solo-en-agents` lo mantiene asi.
 */
export class AnthropicLlm implements LlmPort {
  private readonly client: Anthropic

  constructor(config: AnthropicLlmConfig) {
    if (config.apiKey.trim() === '') {
      throw new ValidationError(
        'AnthropicLlm necesita una clave de API explicita. No se deja que el SDK la resuelva ' +
          'sola: un cliente que busca credenciales por su cuenta puede acabar llamando a la ' +
          'API de verdad desde un test que creia hablar con un doble.',
      )
    }
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }),
    })
  }

  /**
   * Siempre en streaming. No por querer los eventos —no se usan— sino porque
   * una respuesta larga con `max_tokens` alto se come el timeout HTTP de una
   * peticion normal, y el Verifier genera respuestas largas por definicion.
   * `finalMessage()` devuelve el mensaje completo ya ensamblado.
   *
   * Los errores del SDK (`Anthropic.RateLimitError`, `AuthenticationError`,
   * `BadRequestError`...) se propagan TAL CUAL, con su tipo: envolverlos aqui
   * le quitaria al llamante la unica forma que tiene de distinguir lo
   * reintentable de lo que no.
   */
  async complete(request: LlmRequest): Promise<LlmResult> {
    const params = buildMessageParams(request)
    const stream = this.client.messages.stream(params)
    const message = await stream.finalMessage()
    return toLlmResult(message, request)
  }
}
