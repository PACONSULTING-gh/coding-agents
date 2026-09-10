import { spawn } from 'node:child_process'

import {
  LlmProtocolError,
  LlmRefusalError,
  ValidationError,
  type LlmPort,
  type LlmRequest,
  type LlmResult,
  type LlmStopReason,
} from '@coord/core'

/**
 * Implementacion de `LlmPort` sobre el CLI de Claude Code (`claude --print`).
 *
 * ===========================================================================
 * ESTA ES LA RUTA DE PRODUCCION (ADR 0009)
 * ===========================================================================
 * Todo corre sobre la suscripcion de Claude Code, incluidas las llamadas
 * propias de la plataforma: el router y el Verifier pasan por aqui.
 *
 * El PRD §5 decia lo contrario hasta el 10 de septiembre de 2026 —router y
 * Verifier por API de pago por token— y se revisó con el ADR 0009: de sus tres
 * razones tecnicas, dos no aguantaron la medicion (el CLI tambien devuelve el
 * consumo por llamada, y la salida estructurada no evita validar), y la tercera
 * —el aislamiento— se pudo construir y verificar. Ver la seccion siguiente,
 * porque ese aislamiento es el precio de esta decision.
 *
 * `anthropic.ts` sigue existiendo como implementacion alternativa de `LlmPort`,
 * escrita y probada, para el dia que se dispare alguno de los disparadores del
 * ADR 0009 (el primero: el primer cliente de pago). Cambiar de ruta es cambiar
 * que se inyecta en la raiz de composicion.
 *
 * ===========================================================================
 * EL AISLAMIENTO: EL PRECIO DE QUE ESTO SEA PRODUCCION
 * ===========================================================================
 * El primer criterio de T04 es que el Verifier no pueda ir a buscarse contexto.
 * Contra la API eso es estructural: un `POST /v1/messages` sin herramientas no
 * tiene forma de leer un fichero. El CLI es lo contrario —trae un harness con
 * sistema de ficheros, shell y servidores MCP— asi que aqui el aislamiento hay
 * que CONSTRUIRLO, y es mas debil por naturaleza:
 *
 *   - `--disallowed-tools` con toda la superficie conocida (`BLOCKED_TOOLS`).
 *   - `--strict-mcp-config` SIN ningun `--mcp-config`: sin esto, los servidores
 *     MCP del usuario se cargan igual. Medido: con las herramientas locales ya
 *     bloqueadas, el modelo seguia respondiendo que podia leer ficheros "de
 *     Google Drive".
 *   - `--permission-prompts none`, que deniega automaticamente cualquier
 *     llamada a herramienta que se escape de la lista. Es la red, no la puerta.
 *   - `--system-prompt`, que SUSTITUYE el prompt de Claude Code en vez de
 *     añadirse a el: el Verifier no debe heredar la persona de un agente de
 *     codigo.
 *   - Directorio de trabajo vacio (`cwd`), para que no haya nada que leer
 *     aunque algo se escapara.
 *
 * Verificado a mano el 9 de septiembre de 2026 preguntandole al modelo que
 * enumerase sus herramientas: responde `NINGUNA`.
 *
 * DIGAMOSLO CLARO, Y AHORA IMPORTA MAS QUE ANTES: `BLOCKED_TOOLS` es una LISTA
 * NEGRA contra una superficie que se mueve. Claude Code añade herramientas entre
 * versiones, y una herramienta nueva no estaria en esta lista.
 * `--permission-prompts none` cubre ese hueco denegando lo que no se haya
 * nombrado, pero el modelo aun la VE.
 *
 * Contra la API, que el Verifier no pueda buscarse contexto era un HECHO del
 * transporte. Por aqui es una lista que hay que MANTENER, y el primer criterio
 * de aceptacion de T04 (epic 05) depende de ella. Si esta lista se queda atras,
 * el aislamiento se degrada EN SILENCIO — que es el modo de fallo que este
 * proyecto entero existe para evitar. Es el precio del ADR 0009 y esta escrito
 * alli tambien.
 *
 * ===========================================================================
 * LO QUE EL CLI NO SABE HACER, Y AQUI NO SE DISIMULA
 * ===========================================================================
 *   - `maxOutputTokens`: NO se puede fijar. El CLI no tiene un equivalente, asi
 *     que el tope es el suyo. Lo que si se conserva es la DETECCION: si la
 *     respuesta sale truncada, `stop_reason` lo dice y se traduce a
 *     `max_output_tokens`, que es lo que el Verifier comprueba.
 *   - `outputSchema`: no hay salida estructurada garantizada por el proveedor.
 *     Se pide por prompt y se parsea lo que vuelva. Es mas debil que la ruta
 *     API —donde el esquema lo impone el servidor— y por eso se valida con
 *     dureza aqui: si no es JSON, se lanza en vez de devolver `undefined`.
 *   - `cacheBreakpoint`: se ignora. El CLI gestiona su propio cache de prompt.
 *   - `reasoning: 'on-with-summary'`: `--output-format json` no devuelve el
 *     resumen del razonamiento. Se rechaza la peticion en vez de devolver
 *     `undefined` y que el llamante crea que el modelo no razono.
 */

/** El binario, si no se dice otra cosa. Se sobreescribe en los tests. */
const DEFAULT_EXECUTABLE = 'claude'

/** 15 minutos: el Verifier a `xhigh` sobre un diff entero tarda, y el CLI añade su propio arranque. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Toda la superficie de herramientas que se bloquea. Se exporta para que un
 * test pueda fijarla y para que se vea en el diff el dia que cambie: si Claude
 * Code añade una herramienta y nadie toca esta lista, el aislamiento se degrada
 * en silencio.
 */
export const BLOCKED_TOOLS: readonly string[] = [
  // Sistema de ficheros y ejecucion
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'BashOutput',
  'KillShell',
  'Glob',
  'Grep',
  // Red
  'WebFetch',
  'WebSearch',
  // Delegacion: un subagente tendria SUS herramientas, asi que abre el agujero entero
  'Task',
  'Agent',
  'Workflow',
  'Skill',
  'ToolSearch',
  // Coordinacion y efectos laterales
  'ListAgents',
  'SendMessage',
  'Monitor',
  'TaskOutput',
  'TaskStop',
  'RemoteTrigger',
  'PushNotification',
  'CronCreate',
  'CronDelete',
  'CronList',
  'DesignSync',
  'EnterWorktree',
  'ExitWorktree',
  'ScheduleWakeup',
  'ReportFindings',
  'Artifact',
  'SlashCommand',
  'TodoWrite',
  'ExitPlanMode',
  'EnterPlanMode',
  'SendUserFile',
  'EndConversation',
]

export interface ClaudeCliLlmConfig {
  /** Ruta del binario. Por defecto `claude`, resuelto por PATH. */
  readonly executable?: string
  /**
   * Directorio de trabajo de la sesion. DEBE ser un directorio sin nada que
   * leer: es la ultima linea de defensa si alguna herramienta se escapara de
   * `BLOCKED_TOOLS`.
   */
  readonly cwd: string
  readonly timeoutMs?: number
}

/** Traduce las razones de parada del CLI al vocabulario del puerto. */
function toStopReason(stopReason: unknown): LlmStopReason {
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

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LlmProtocolError(`${what} no es un objeto: ${JSON.stringify(value)?.slice(0, 200)}`)
  }
  return value as Record<string, unknown>
}

/** Un entero del JSON del CLI, o 0 si no viene. Nunca `NaN`: `usage` se rellena siempre. */
function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * El modelo suele devolver el JSON dentro de una valla de Markdown aunque se le
 * pida que no. Quitarla es traduccion del proveedor, no indulgencia con el
 * contenido: lo de dentro se sigue parseando y lanzando si no cuadra.
 */
function stripCodeFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/u.exec(text)
  return fenced?.[1] ?? text
}

export class ClaudeCliLlm implements LlmPort {
  readonly #executable: string
  readonly #cwd: string
  readonly #timeoutMs: number

  constructor(config: ClaudeCliLlmConfig) {
    if (config.cwd.trim() === '') {
      throw new ValidationError(
        'ClaudeCliLlm necesita un `cwd` explicito, y tiene que ser un directorio vacio: es la ' +
          'ultima defensa del aislamiento si alguna herramienta se escapa de BLOCKED_TOOLS.',
      )
    }
    this.#executable = config.executable ?? DEFAULT_EXECUTABLE
    this.#cwd = config.cwd
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const prompt = this.#buildPrompt(request)
    const raw = await this.#run(this.#buildArgs(request), prompt)
    return this.#toResult(request, raw)
  }

  /**
   * El CLI acepta UN prompt, no una conversacion. El Verifier manda un solo
   * mensaje de usuario, asi que eso es lo unico que se soporta: fabricar una
   * conversacion concatenando turnos cambiaria lo que el modelo ve sin que el
   * llamante se entere.
   */
  #buildPrompt(request: LlmRequest): string {
    const [message, ...rest] = request.messages
    if (message === undefined || rest.length > 0) {
      throw new LlmProtocolError(
        `El CLI de Claude Code acepta un unico mensaje de usuario y se le pasaron ` +
          `${String(request.messages.length)}. Este adaptador no simula una conversacion.`,
      )
    }
    if (message.role !== 'user') {
      throw new LlmProtocolError(
        `El unico mensaje tiene que ser del usuario, y es '${message.role}'.`,
      )
    }
    return message.content
  }

  #buildArgs(request: LlmRequest): string[] {
    if (request.reasoning === 'on-with-summary') {
      throw new LlmProtocolError(
        "`reasoning: 'on-with-summary'` no se soporta sobre el CLI: `--output-format json` no " +
          'devuelve el resumen del razonamiento. Usa la ruta de API si necesitas el resumen.',
      )
    }

    const args = [
      '--print',
      '--output-format',
      'json',
      '--model',
      request.model,
      // El aislamiento. Ver la cabecera de este fichero.
      '--strict-mcp-config',
      '--permission-prompts',
      'none',
      '--disallowed-tools',
      ...BLOCKED_TOOLS,
    ]

    if (request.effort !== undefined) {
      args.push('--effort', request.effort)
    }

    // `--system-prompt` SUSTITUYE el de Claude Code; `--append-system-prompt` lo
    // añadiria. Aqui hay que sustituir: el Verifier corre en contexto limpio.
    args.push('--system-prompt', this.#buildSystemPrompt(request))
    return args
  }

  #buildSystemPrompt(request: LlmRequest): string {
    // `cacheBreakpoint` se ignora: el corte de cache es un mecanismo del
    // proveedor y el CLI gestiona el suyo.
    const blocks = (request.system ?? []).map((block) => block.text)
    if (request.outputSchema !== undefined) {
      blocks.push(
        'FORMATO DE SALIDA. Responde EXCLUSIVAMENTE con un objeto JSON valido que cumpla este ' +
          `JSON Schema, sin texto antes ni despues y sin vallas de Markdown:\n` +
          JSON.stringify(request.outputSchema.schema),
      )
    }
    return blocks.join('\n\n')
  }

  #run(args: readonly string[], prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#executable, args, {
        cwd: this.#cwd,
        // El prompt va por stdin y no como argumento: un diff entero pasa del
        // limite de longitud de la linea de comandos.
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(
          new LlmProtocolError(
            `El CLI de Claude Code no respondio en ${String(this.#timeoutMs)} ms.`,
          ),
        )
      }, this.#timeoutMs)

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => (stdout += chunk))
      child.stderr.on('data', (chunk: string) => (stderr += chunk))

      // Los errores de transporte del proceso se propagan con su tipo, igual
      // que los del SDK: nada de convertirlos en un resultado vacio.
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        // El codigo de salida NO decide solo. El CLI sale con 1 tambien cuando
        // el modelo se NIEGA, y una negativa tiene que llegar al llamante como
        // `LlmRefusalError` —obligacion 1 del puerto— y no disfrazada de fallo
        // de transporte: son cosas distintas y se actua distinto ante cada una.
        // Medido: una negativa por `reasoning_extraction` salia con codigo 1 y
        // un JSON perfectamente valido en stdout.
        if (code === 0 || stdout.trim() !== '') {
          resolve(stdout)
          return
        }
        reject(
          new LlmProtocolError(
            `El CLI de Claude Code salio con codigo ${String(code)} y sin salida: ${stderr.trim()}`,
          ),
        )
      })

      child.stdin.end(prompt, 'utf8')
    })
  }

  #toResult(request: LlmRequest, stdout: string): LlmResult {
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch (cause) {
      throw new LlmProtocolError(`La salida del CLI no es JSON: ${stdout.slice(0, 200)}`, { cause })
    }
    const payload = asRecord(parsed, 'La salida del CLI')

    // Obligacion 1 del puerto: mirar por que paro ANTES de leer el contenido.
    if (payload['stop_reason'] === 'refusal') {
      const explanation = typeof payload['result'] === 'string' ? payload['result'] : undefined
      throw new LlmRefusalError({
        // El CLI no trae `stop_details`: mete la categoria dentro del texto,
        // como "Details: `[reasoning_extraction]`". Sacarla de ahi es traducir
        // del proveedor al puerto, y sin ella el llamante no puede distinguir
        // una negativa de politica de una de contenido.
        category: /Details:\s*`?\[([a-z_]+)\]`?/u.exec(explanation ?? '')?.[1],
        explanation,
      })
    }
    // La negativa se comprueba ANTES que `is_error`, porque el CLI marca las dos
    // cosas a la vez: `is_error: true` con `stop_reason: 'refusal'` es una
    // negativa, no un fallo de transporte.
    if (payload['is_error'] === true || payload['subtype'] !== 'success') {
      throw new LlmProtocolError(
        `El CLI informa de un fallo (subtype=${String(payload['subtype'])}, ` +
          `api_error_status=${String(payload['api_error_status'])}): ${String(payload['result'])}`,
      )
    }

    const text = payload['result']
    if (typeof text !== 'string') {
      throw new LlmProtocolError(
        `El CLI no devolvio texto en \`result\`: ${JSON.stringify(text)?.slice(0, 200)}`,
      )
    }

    const usage = asRecord(payload['usage'] ?? {}, '`usage`')
    return {
      text,
      structured: this.#toStructured(request, text),
      reasoningSummary: undefined,
      stopReason: toStopReason(payload['stop_reason']),
      model: this.#toModel(payload, request),
      usage: {
        inputTokens: toCount(usage['input_tokens']),
        outputTokens: toCount(usage['output_tokens']),
        cacheReadInputTokens: toCount(usage['cache_read_input_tokens']),
        cacheCreationInputTokens: toCount(usage['cache_creation_input_tokens']),
      },
    }
  }

  #toStructured(request: LlmRequest, text: string): unknown {
    if (request.outputSchema === undefined) return undefined
    try {
      return JSON.parse(stripCodeFence(text))
    } catch (cause) {
      // No se devuelve `undefined`: se pidio salida estructurada y no la hay.
      // Quien llame tiene que enterarse, no recibir un hueco silencioso.
      throw new LlmProtocolError(
        `Se pidio salida estructurada (${request.outputSchema.name}) y el CLI devolvio algo que ` +
          `no es JSON: ${text.slice(0, 200)}`,
        { cause },
      )
    }
  }

  /**
   * Que modelo respondio DE VERDAD. El CLI no lo dice en un campo suelto: lo
   * dice en las claves de `modelUsage`, que ademas llevan sufijos de ventana
   * (`claude-opus-5[1m]`). Se prefiere la clave que mas tokens de salida gasto,
   * porque Claude Code usa modelos auxiliares baratos para tareas internas y el
   * que contesto es el que escribio.
   */
  #toModel(payload: Record<string, unknown>, request: LlmRequest): string {
    const modelUsage = payload['modelUsage']
    if (typeof modelUsage !== 'object' || modelUsage === null) return request.model
    let best: { model: string; outputTokens: number } | undefined
    for (const [model, value] of Object.entries(modelUsage as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const outputTokens = toCount((value as Record<string, unknown>)['outputTokens'])
      if (best === undefined || outputTokens > best.outputTokens) best = { model, outputTokens }
    }
    return best?.model ?? request.model
  }
}
