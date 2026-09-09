import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * ===========================================================================
 * EL DOBLE DE LA API DE MENSAJES. LEELO ANTES DE CITAR NINGUN TEST COMO PRUEBA
 * DE QUE ALGO FUNCIONA CONTRA CLAUDE.
 * ===========================================================================
 * En la maquina donde se escribio esto NO hay credenciales de Anthropic, asi
 * que NUNCA se ha llamado a la API de verdad y no se intenta.
 *
 * Esto NO es un mock del SDK (CLAUDE.md 5, "nada de mocks de lo que no
 * controlas"). Es el mismo patron que se uso con la API de GitHub en el epic 01
 * T05: un servidor HTTP DE VERDAD en localhost que habla el protocolo de
 * eventos de la API, y el cliente apuntado ahi con `baseURL`. Se ejercita el
 * camino entero —construir la peticion, mandarla por HTTP, leer el stream,
 * ensamblarlo y traducirlo al dominio— y no que un doble devuelva lo que le
 * hemos dicho.
 *
 * LO QUE ESTO NO PRUEBA: que el servidor real se comporte como este doble. Si
 * la API cambia una forma, aqui seguira todo en verde. "Los tests pasan" NO es
 * "probado contra Claude" (CLAUDE.md 6).
 */

export interface RecordedRequest {
  readonly path: string
  readonly body: Record<string, unknown>
  readonly headers: Record<string, string | string[] | undefined>
}

export interface FakeApi {
  readonly baseUrl: string
  readonly requests: RecordedRequest[]
  /** Lo que respondera la siguiente peticion. */
  reply: (response: ServerResponse) => void
  close: () => Promise<void>
}

export function sse(events: readonly { event: string; data: unknown }[]): string {
  return events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')
}

export interface StreamOptions {
  readonly text?: string
  readonly thinking?: string
  readonly stopReason?: string
  readonly stopDetails?: unknown
  readonly usage?: Record<string, unknown>
  /** Modelo que declara el mensaje. Por defecto el del Verifier. */
  readonly model?: string
}

/** Modelo por defecto del doble. Lo sobreescribe `StreamOptions.model`. */
const DEFAULT_FAKE_MODEL = 'claude-opus-5'

/** Los eventos que la API emite para un mensaje sencillo, en su orden real. */
export function messageStream(options: StreamOptions): string {
  // El `usage` final. La API lo reparte en dos: los contadores de entrada
  // llegan en `message_start` y solo se reescriben en `message_delta` cuando
  // vienen con valor. El doble reproduce ese reparto, porque si mandara los
  // contadores de entrada solo en el delta, el test pasaria por una via que la
  // API real no usa.
  const usage = options.usage ?? {
    input_tokens: 1200,
    output_tokens: 42,
    cache_creation_input_tokens: 300,
    cache_read_input_tokens: 900,
  }

  const events: { event: string; data: unknown }[] = []
  events.push({
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: 'msg_doble_local',
        type: 'message',
        role: 'assistant',
        model: options.model ?? DEFAULT_FAKE_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: {
          ...usage,
          output_tokens: 0,
          cache_creation: null,
          inference_geo: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: null,
        },
      },
    },
  })

  let index = 0
  if (options.thinking !== undefined) {
    events.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
    })
    events.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: options.thinking },
      },
    })
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } })
    index += 1
  }

  if (options.text !== undefined) {
    events.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '', citations: null },
      },
    })
    // En dos trozos a proposito: si el ensamblado se hiciera mal, un solo
    // fragmento lo ocultaria.
    const mitad = Math.ceil(options.text.length / 2)
    for (const trozo of [options.text.slice(0, mitad), options.text.slice(mitad)]) {
      events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: trozo } },
      })
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } })
  }

  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: {
        stop_reason: options.stopReason ?? 'end_turn',
        stop_sequence: null,
        stop_details: options.stopDetails ?? null,
        container: null,
      },
      usage,
    },
  })
  events.push({ event: 'message_stop', data: { type: 'message_stop' } })
  return sse(events)
}

export function streamResponse(options: StreamOptions): (response: ServerResponse) => void {
  return (response) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    })
    response.end(messageStream(options))
  }
}

/** Respuesta de error HTTP, para comprobar que el error llega con su tipo. */
export function errorResponse(
  status: number,
  errorType: string,
): (response: ServerResponse) => void {
  return (response) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: errorType } }))
  }
}

export async function startFakeApi(): Promise<FakeApi> {
  const requests: RecordedRequest[] = []
  const state = { reply: streamResponse({ text: 'ok' }) }

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({
        path: request.url ?? '',
        body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
        headers: request.headers,
      })
      state.reply(response)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    set reply(value: (response: ServerResponse) => void) {
      state.reply = value
    },
    get reply() {
      return state.reply
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      }),
  }
}

/**
 * Clave aleatoria por ejecucion. No vale para nada y no sale del proceso: en el
 * repositorio no hay ninguna credencial, ni siquiera de test (CLAUDE.md 5).
 */
export function throwawayApiKey(): string {
  return `sk-ant-test-${randomBytes(16).toString('hex')}`
}
