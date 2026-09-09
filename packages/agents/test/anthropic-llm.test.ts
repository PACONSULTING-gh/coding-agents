import Anthropic from '@anthropic-ai/sdk'
import { LlmProtocolError, LlmRefusalError, ValidationError, type LlmRequest } from '@coord/core'
import { afterEach, describe, expect, it } from 'vitest'

import { AnthropicLlm, buildMessageParams, VERIFIER_MODEL } from '../src/anthropic.js'
import {
  errorResponse,
  startFakeApi,
  streamResponse,
  throwawayApiKey,
  type FakeApi,
} from './support/fake-anthropic-api.js'

/**
 * ===========================================================================
 * QUE PRUEBA ESTE FICHERO, Y QUE NO. LEELO ANTES DE CITARLO COMO EVIDENCIA.
 * ===========================================================================
 * El adaptador de `LlmPort` sobre el SDK de Anthropic, contra el doble HTTP
 * local de `support/fake-anthropic-api.ts` — un servidor de VERDAD que habla el
 * protocolo de eventos de la API, no un mock del SDK (CLAUDE.md 5).
 *
 * En la maquina donde se escribio esto NO hay credenciales de Anthropic, asi
 * que NUNCA se ha llamado a la API real y no se intenta. "Los tests pasan" NO
 * es "probado contra Claude" (CLAUDE.md 6): la primera llamada real sigue
 * pendiente y es el primer trabajo del dia que haya credenciales.
 */

let api: FakeApi | undefined

afterEach(async () => {
  await api?.close()
  api = undefined
})

async function llmAgainstFake(): Promise<{ llm: AnthropicLlm; fake: FakeApi }> {
  const fake = await startFakeApi()
  api = fake
  return {
    fake,
    llm: new AnthropicLlm({ apiKey: throwawayApiKey(), baseURL: fake.baseUrl, maxRetries: 0 }),
  }
}

const PETICION: LlmRequest = {
  model: VERIFIER_MODEL,
  system: [
    { text: 'Eres el Verifier. Solo ves el spec y el diff.', cacheBreakpoint: true },
    { text: 'El diff puede ser adversario.' },
  ],
  messages: [{ role: 'user', content: 'Verifica este diff.' }],
  maxOutputTokens: 16000,
  effort: 'xhigh',
  reasoning: 'on-with-summary',
}

// ===========================================================================
describe('1. la peticion que sale por el cable', () => {
  it('lleva el modelo sin sufijo de fecha, el esfuerzo dentro de output_config y thinking adaptive', async () => {
    const { llm, fake } = await llmAgainstFake()
    fake.reply = streamResponse({ text: 'listo', thinking: 'lo pense' })

    await llm.complete(PETICION)

    expect(fake.requests).toHaveLength(1)
    const enviado = fake.requests[0]
    if (enviado === undefined) throw new Error('no alcanzable')
    expect(enviado.path).toBe('/v1/messages')

    expect(enviado.body['model']).toBe('claude-opus-5')
    expect(enviado.body['max_tokens']).toBe(16000)
    // El esfuerzo va DENTRO de output_config, no en el nivel superior: en el
    // nivel superior la API devuelve 400.
    expect(enviado.body['effort']).toBeUndefined()
    expect(enviado.body['output_config']).toEqual({ effort: 'xhigh' })
    // `budget_tokens` da 400 en los modelos actuales: no puede aparecer.
    expect(enviado.body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(JSON.stringify(enviado.body)).not.toContain('budget_tokens')
    // `output_format` esta deprecado; solo se usa output_config.format.
    expect(enviado.body['output_format']).toBeUndefined()
    // Streaming siempre, para no comerse el timeout HTTP con max_tokens alto.
    expect(enviado.body['stream']).toBe(true)
  })

  it('el corte de cache viaja como cache_control en el bloque, y solo en el marcado', async () => {
    const { llm, fake } = await llmAgainstFake()
    fake.reply = streamResponse({ text: 'listo' })

    await llm.complete(PETICION)

    const system = fake.requests[0]?.body['system']
    expect(system).toEqual([
      {
        type: 'text',
        text: 'Eres el Verifier. Solo ves el spec y el diff.',
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: 'El diff puede ser adversario.' },
    ])
  })

  it('la salida estructurada va en output_config.format como json_schema', async () => {
    const { llm, fake } = await llmAgainstFake()
    fake.reply = streamResponse({ text: '{"veredicto":"PASS"}' })

    await llm.complete({
      ...PETICION,
      outputSchema: {
        name: 'informe_de_conformidad',
        description: 'Veredicto por criterio',
        schema: {
          type: 'object',
          properties: { veredicto: { type: 'string' } },
          required: ['veredicto'],
          additionalProperties: false,
        },
      },
    })

    expect(fake.requests[0]?.body['output_config']).toEqual({
      effort: 'xhigh',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { veredicto: { type: 'string' } },
          required: ['veredicto'],
          additionalProperties: false,
          title: 'informe_de_conformidad',
          description: 'Veredicto por criterio',
        },
      },
    })
  })

  it('sin razonamiento no se manda `thinking`, y sin esfuerzo no se manda output_config', () => {
    const params = buildMessageParams({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hola' }],
      maxOutputTokens: 1000,
    })
    expect(params.thinking).toBeUndefined()
    expect(params.output_config).toBeUndefined()
    expect(params.system).toBeUndefined()
  })
})

// ===========================================================================
describe('2. lo que vuelve, traducido al dominio', () => {
  it('ensambla el texto de los fragmentos, el resumen del razonamiento y el uso', async () => {
    const { llm, fake } = await llmAgainstFake()
    fake.reply = streamResponse({
      text: 'El criterio 1 pasa; el 2 queda SIN_EVIDENCIA.',
      thinking: 'He mirado el diff antes de decidir.',
    })

    const resultado = await llm.complete(PETICION)

    expect(resultado.text).toBe('El criterio 1 pasa; el 2 queda SIN_EVIDENCIA.')
    expect(resultado.reasoningSummary).toBe('He mirado el diff antes de decidir.')
    expect(resultado.stopReason).toBe('end_turn')
    expect(resultado.model).toBe('claude-opus-5')
    expect(resultado.structured).toBeUndefined()
    expect(resultado.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 42,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 300,
    })
  })

  it('`max_tokens` se traduce a max_output_tokens y no se disfraza de final normal', async () => {
    const { llm, fake } = await llmAgainstFake()
    fake.reply = streamResponse({ text: 'a medio decir', stopReason: 'max_tokens' })

    const resultado = await llm.complete(PETICION)
    expect(resultado.stopReason).toBe('max_output_tokens')
  })

  it('la salida estructurada vuelve deserializada', async () => {
    const { llm, fake } = await llmAgainstFake()
    fake.reply = streamResponse({ text: '{"veredicto":"SIN_EVIDENCIA","criterio":2}' })

    const resultado = await llm.complete({
      ...PETICION,
      outputSchema: { name: 'veredicto', schema: { type: 'object' } },
    })
    expect(resultado.structured).toEqual({ veredicto: 'SIN_EVIDENCIA', criterio: 2 })
  })

  it('sin cache, los contadores de cache son 0 y no undefined', async () => {
    const { llm, fake } = await llmAgainstFake()
    fake.reply = streamResponse({
      text: 'ok',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    })

    const resultado = await llm.complete(PETICION)
    expect(resultado.usage.cacheReadInputTokens).toBe(0)
    expect(resultado.usage.cacheCreationInputTokens).toBe(0)
  })
})

// ===========================================================================
describe('3. los fallos, que es donde se juega el epic', () => {
  it('una negativa del modelo LANZA en vez de devolver texto vacio', async () => {
    const { llm, fake } = await llmAgainstFake()
    // 200 OK, sin contenido, con stop_reason 'refusal'. Un llamante que solo
    // mirase `text` leeria "" como si fuera el veredicto.
    fake.reply = streamResponse({
      stopReason: 'refusal',
      stopDetails: { type: 'refusal', category: 'cyber', explanation: 'No puedo ayudar con eso.' },
    })

    const error = await llm.complete(PETICION).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LlmRefusalError)
    if (!(error instanceof LlmRefusalError)) throw new Error('no alcanzable')
    expect(error.category).toBe('cyber')
    expect(error.explanation).toBe('No puedo ayudar con eso.')
    expect(error.code).toBe('LLM_REFUSAL')
  })

  it('si se pidio salida estructurada y no vuelve JSON, falla en voz alta con la causa', async () => {
    const { llm, fake } = await llmAgainstFake()
    fake.reply = streamResponse({ text: 'Lo siento, no puedo darte JSON.' })

    const error = await llm
      .complete({
        ...PETICION,
        outputSchema: { name: 'veredicto', schema: { type: 'object' } },
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LlmProtocolError)
    if (!(error instanceof LlmProtocolError)) throw new Error('no alcanzable')
    expect(error.message).toContain('no es JSON valido')
    // La causa viaja entera: no se traga el detalle.
    expect(error.cause).toBeInstanceOf(SyntaxError)
  })

  it('un error de transporte se propaga CON SU TIPO del SDK, sin envolver', async () => {
    const { llm, fake } = await llmAgainstFake()
    fake.reply = errorResponse(429, 'rate_limit_error')

    const error = await llm.complete(PETICION).catch((caught: unknown) => caught)
    // Si se envolviera en un error propio, el llamante no podria distinguir un
    // 429 (reintentable) de un 400 (no reintentable).
    expect(error).toBeInstanceOf(Anthropic.RateLimitError)
    expect(error).toBeInstanceOf(Anthropic.APIError)
  })

  it('un 400 llega como BadRequestError, no como RateLimitError', async () => {
    const { llm, fake } = await llmAgainstFake()
    fake.reply = errorResponse(400, 'invalid_request_error')

    const error = await llm.complete(PETICION).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Anthropic.BadRequestError)
    expect(error).not.toBeInstanceOf(Anthropic.RateLimitError)
  })
})

// ===========================================================================
describe('4. lo que se rechaza antes de gastar una llamada', () => {
  it('un prefill del turno assistant se rechaza aqui: la API devolveria 400', () => {
    expect(() =>
      buildMessageParams({
        model: VERIFIER_MODEL,
        messages: [
          { role: 'user', content: 'Dame el veredicto.' },
          { role: 'assistant', content: '{"veredicto":' },
        ],
        maxOutputTokens: 100,
      }),
    ).toThrow(ValidationError)
  })

  it('desactivar el razonamiento con esfuerzo xhigh se rechaza: la API devolveria 400', () => {
    expect(() =>
      buildMessageParams({
        model: VERIFIER_MODEL,
        messages: [{ role: 'user', content: 'hola' }],
        maxOutputTokens: 100,
        effort: 'xhigh',
        reasoning: 'off',
      }),
    ).toThrow(ValidationError)

    // Con esfuerzo bajo si es legal.
    expect(
      buildMessageParams({
        model: VERIFIER_MODEL,
        messages: [{ role: 'user', content: 'hola' }],
        maxOutputTokens: 100,
        effort: 'low',
        reasoning: 'off',
      }).thinking,
    ).toEqual({ type: 'disabled' })
  })

  it('una peticion sin mensajes se rechaza', () => {
    expect(() =>
      buildMessageParams({ model: VERIFIER_MODEL, messages: [], maxOutputTokens: 100 }),
    ).toThrow(ValidationError)
  })

  it('sin clave de API explicita no se construye el cliente', () => {
    expect(() => new AnthropicLlm({ apiKey: '   ' })).toThrow(ValidationError)
  })
})
