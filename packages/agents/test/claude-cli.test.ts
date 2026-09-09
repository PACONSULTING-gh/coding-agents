import { describe, expect, it } from 'vitest'

import { LlmProtocolError, LlmRefusalError, ValidationError, type LlmRequest } from '@coord/core'

import { BLOCKED_TOOLS, ClaudeCliLlm } from '../src/claude-cli.js'
import { startFakeClaudeCli, successPayload } from './support/fake-claude-cli.js'

/**
 * `ClaudeCliLlm` contra un `claude` de mentira que es un ejecutable DE VERDAD
 * (ver `support/fake-claude-cli.ts`): se ejercita el spawn, el prompt por
 * stdin, el codigo de salida y el parseo, que es donde estan los errores de un
 * adaptador de proceso.
 *
 * Lo que estos tests NO dicen: si el CLI real se comporta asi. La forma de la
 * respuesta esta copiada de una llamada real, pero un doble no valida un
 * contrato ajeno.
 */

const BASE_REQUEST: LlmRequest = {
  model: 'claude-opus-5',
  system: [{ text: 'Eres el Verifier.', cacheBreakpoint: true }],
  messages: [{ role: 'user', content: 'El diff a verificar' }],
  maxOutputTokens: 8_000,
  effort: 'xhigh',
  reasoning: 'on',
}

async function completeWith(payload: unknown, request: LlmRequest = BASE_REQUEST) {
  const fake = await startFakeClaudeCli({ stdout: payload })
  const llm = new ClaudeCliLlm({ executable: fake.executable, cwd: fake.cwd })
  return { fake, result: await llm.complete(request) }
}

describe('el aislamiento va en la invocacion, y se comprueba en la invocacion', () => {
  it('bloquea toda la superficie de herramientas, MCP incluido, y sustituye el system prompt', async () => {
    const { fake } = await completeWith(successPayload())
    const { args } = await fake.invocation()

    // Sin esto, los servidores MCP del usuario se cargan igual y el Verifier
    // acaba con herramientas de lectura que nadie le dio (medido a mano).
    expect(args).toContain('--strict-mcp-config')
    // La red por debajo de la lista negra: lo que no este nombrado, se deniega.
    expect(args.slice(args.indexOf('--permission-prompts'))[1]).toBe('none')
    // Y la lista negra entera, sin faltar ni una.
    for (const tool of BLOCKED_TOOLS) {
      expect(args, `falta ${tool} en --disallowed-tools`).toContain(tool)
    }
    // `--system-prompt` SUSTITUYE; `--append-system-prompt` heredaria la
    // persona del agente de codigo, que es justo lo que no puede pasar.
    expect(args).toContain('--system-prompt')
    expect(args).not.toContain('--append-system-prompt')
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('Eres el Verifier.')
  })

  it('la lista negra incluye las herramientas que delegan en otro agente', () => {
    // Un subagente tendria SUS herramientas: dejar `Task` o `Workflow` abiertos
    // abre el agujero entero, por mucho que Read este bloqueado.
    for (const tool of ['Task', 'Agent', 'Workflow', 'Skill', 'Bash', 'Read', 'WebFetch']) {
      expect(BLOCKED_TOOLS).toContain(tool)
    }
  })

  it('el modelo y el esfuerzo se pasan tal cual, y el prompt va por stdin', async () => {
    const { fake } = await completeWith(successPayload())
    const { args, stdin } = await fake.invocation()

    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5')
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh')
    expect(args).toContain('--print')
    expect(args[args.indexOf('--output-format') + 1]).toBe('json')
    // Por stdin y no como argumento: un diff entero pasa del limite de la
    // linea de comandos.
    expect(stdin).toBe('El diff a verificar')
    expect(args).not.toContain('El diff a verificar')
  })

  it('exige un cwd, porque es la ultima defensa si algo se escapa', () => {
    expect(() => new ClaudeCliLlm({ cwd: '   ' })).toThrow(ValidationError)
  })
})

describe('la traduccion de la respuesta', () => {
  it('rellena usage con las cuatro cifras y dice que modelo respondio de verdad', async () => {
    const { result } = await completeWith(successPayload())

    expect(result.text).toBe('OK')
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadInputTokens: 33,
      cacheCreationInputTokens: 44,
    })
    // Claude Code usa modelos auxiliares baratos para tareas internas: el que
    // contesto es el que mas salida gasto, no el primero de la lista.
    expect(result.model).toBe('claude-opus-5[1m]')
  })

  it('usage se rellena aunque el CLI no mande ninguna cifra', async () => {
    // Obligacion 2 del puerto. Un `usage` a medias con NaN dentro seria peor
    // que ceros: contaminaria cualquier suma de coste.
    const { result } = await completeWith(successPayload({ usage: {} }))
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    })
  })

  it('una respuesta truncada se sigue detectando aunque el tope no se pueda fijar', async () => {
    // El CLI no acepta `maxOutputTokens`, pero SI dice cuando trunco. Esa es la
    // mitad que el Verifier comprueba, y no se pierde.
    const { result } = await completeWith(successPayload({ stop_reason: 'max_tokens' }))
    expect(result.stopReason).toBe('max_output_tokens')
  })
})

describe('lo que no se deja pasar en silencio', () => {
  it('una negativa del modelo se lanza, no se devuelve como texto vacio', async () => {
    // El CLI NO manda un `stop_details`: mete el motivo dentro de `result`.
    // Esta fixture esta copiada de una negativa real, no inventada.
    const fake = await startFakeClaudeCli({
      stdout: successPayload({
        stop_reason: 'refusal',
        result: "API Error: Opus 5's safeguards flagged this message. Details: `[cyber]`",
      }),
    })
    const llm = new ClaudeCliLlm({ executable: fake.executable, cwd: fake.cwd })

    // Obligacion 1 del puerto: mirar la razon de parada ANTES del contenido. Un
    // llamante que leyera `text` veria el texto del error y lo tomaria por la
    // respuesta del modelo.
    await expect(llm.complete(BASE_REQUEST)).rejects.toThrow(LlmRefusalError)
    await expect(llm.complete(BASE_REQUEST)).rejects.toThrow(/cyber/)
  })

  it('una negativa sigue siendo negativa aunque el CLI salga con codigo 1', async () => {
    // REGRESION medida contra el CLI real: una negativa por
    // `reasoning_extraction` sale con codigo de salida 1, `is_error: true` y un
    // JSON perfectamente valido en stdout. Si el adaptador decide por el codigo
    // de salida, la convierte en un fallo de transporte y el llamante no puede
    // distinguir "el modelo se nego" de "el proceso peto".
    const fake = await startFakeClaudeCli({
      exitCode: 1,
      stdout: successPayload({
        stop_reason: 'refusal',
        is_error: true,
        result:
          "API Error: Opus 5's safeguards flagged this message. Details: `[reasoning_extraction]`",
      }),
    })
    const llm = new ClaudeCliLlm({ executable: fake.executable, cwd: fake.cwd })

    const error = await llm.complete(BASE_REQUEST).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LlmRefusalError)
    // Y la categoria se saca del texto, que es donde el CLI la mete.
    expect((error as LlmRefusalError).category).toBe('reasoning_extraction')
  })

  it('un fallo declarado por el CLI se lanza', async () => {
    const fake = await startFakeClaudeCli({
      stdout: successPayload({ is_error: true, subtype: 'error_during_execution' }),
    })
    const llm = new ClaudeCliLlm({ executable: fake.executable, cwd: fake.cwd })
    await expect(llm.complete(BASE_REQUEST)).rejects.toThrow(LlmProtocolError)
  })

  it('un codigo de salida distinto de cero se lanza con lo que dijo stderr', async () => {
    const fake = await startFakeClaudeCli({ stdout: '', exitCode: 1, stderr: 'no autenticado' })
    const llm = new ClaudeCliLlm({ executable: fake.executable, cwd: fake.cwd })
    await expect(llm.complete(BASE_REQUEST)).rejects.toThrow(/no autenticado/)
  })

  it('una salida que no es JSON se lanza', async () => {
    const fake = await startFakeClaudeCli({ stdout: 'esto no es json' })
    const llm = new ClaudeCliLlm({ executable: fake.executable, cwd: fake.cwd })
    await expect(llm.complete(BASE_REQUEST)).rejects.toThrow(LlmProtocolError)
  })
})

describe('salida estructurada: se pide por prompt y se valida con dureza', () => {
  const withSchema: LlmRequest = {
    ...BASE_REQUEST,
    outputSchema: {
      name: 'conformance_verdicts',
      schema: { type: 'object', properties: { veredicto: { type: 'string' } } },
    },
  }

  it('el esquema viaja en el system prompt, porque el CLI no tiene salida estructurada', async () => {
    const { fake } = await completeWith(
      successPayload({ result: '{"veredicto":"PASS"}' }),
      withSchema,
    )
    const { args } = await fake.invocation()
    const systemPrompt = args[args.indexOf('--system-prompt') + 1] ?? ''

    expect(systemPrompt).toContain('Eres el Verifier.')
    expect(systemPrompt).toContain('"veredicto"')
  })

  it('el JSON vuelve deserializado, aunque venga dentro de una valla de Markdown', async () => {
    const { result } = await completeWith(
      successPayload({ result: '```json\n{"veredicto":"PASS"}\n```' }),
      withSchema,
    )
    expect(result.structured).toEqual({ veredicto: 'PASS' })
  })

  it('si se pidio esquema y no vuelve JSON, se lanza en vez de devolver undefined', async () => {
    // Devolver `undefined` dejaria al Verifier sin veredictos y sin saber por
    // que: parecería que el modelo no encontro nada.
    const fake = await startFakeClaudeCli({ stdout: successPayload({ result: 'lo siento' }) })
    const llm = new ClaudeCliLlm({ executable: fake.executable, cwd: fake.cwd })
    await expect(llm.complete(withSchema)).rejects.toThrow(/no es JSON/)
  })

  it('sin esquema, `structured` es undefined y no se intenta parsear nada', async () => {
    const { result } = await completeWith(successPayload({ result: '{"a":1}' }))
    expect(result.structured).toBeUndefined()
  })
})

describe('lo que el adaptador rechaza en vez de fingir', () => {
  it('una conversacion de varios mensajes: el CLI acepta un prompt, no una conversacion', async () => {
    const fake = await startFakeClaudeCli({ stdout: successPayload() })
    const llm = new ClaudeCliLlm({ executable: fake.executable, cwd: fake.cwd })
    await expect(
      llm.complete({
        ...BASE_REQUEST,
        messages: [
          { role: 'user', content: 'uno' },
          { role: 'assistant', content: 'dos' },
        ],
      }),
    ).rejects.toThrow(LlmProtocolError)
  })

  it('un resumen de razonamiento que el CLI no puede dar', async () => {
    const fake = await startFakeClaudeCli({ stdout: successPayload() })
    const llm = new ClaudeCliLlm({ executable: fake.executable, cwd: fake.cwd })
    await expect(llm.complete({ ...BASE_REQUEST, reasoning: 'on-with-summary' })).rejects.toThrow(
      /no se soporta/,
    )
  })
})
