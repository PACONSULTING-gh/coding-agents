import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Anthropic from '@anthropic-ai/sdk'
import { LlmProtocolError, LlmRefusalError, ValidationError } from '@coord/core'
import { afterEach, describe, expect, it } from 'vitest'

import { AnthropicLlm, VERIFIER_MODEL } from '../src/anthropic.js'
import {
  allCriteriaPass,
  verdictFor,
  verifyChanges,
  DIFF_CLOSE,
  DIFF_OPEN,
  MIN_QUOTE_LENGTH,
  type CriterionVerdictValue,
  type EvidenceSource,
  type VerificationInput,
} from '../src/verification/verifier.js'
import type { TraceableCriterion } from '../src/verification/test-generator.js'
import {
  errorResponse,
  startFakeApi,
  streamResponse,
  throwawayApiKey,
  type FakeApi,
} from './support/fake-anthropic-api.js'

/**
 * T04 — el Verifier en contexto aislado. Los cuatro criterios de aceptacion.
 *
 * Contra el doble HTTP local (`support/fake-anthropic-api.ts`), no contra un
 * mock del SDK, y NUNCA contra la API de Anthropic: en esta maquina no hay
 * credenciales y no se intenta. Todo lo que afirman estos tests es sobre el
 * AISLAMIENTO, la FORMA de la peticion y las REGLAS de validacion de la
 * respuesta. Ninguno dice nada sobre lo bien que el modelo real detecta
 * trampas: eso lo mide `trap-suite.test.ts`, y solo cuenta contra el modelo de
 * verdad.
 */

let api: FakeApi | undefined

afterEach(async () => {
  await api?.close()
  api = undefined
})

async function verifierAgainstFake(): Promise<{ llm: AnthropicLlm; fake: FakeApi }> {
  const fake = await startFakeApi()
  api = fake
  return {
    fake,
    llm: new AnthropicLlm({ apiKey: throwawayApiKey(), baseURL: fake.baseUrl, maxRetries: 0 }),
  }
}

const CRITERIOS: readonly TraceableCriterion[] = [
  {
    id: 'c-dead-letter',
    ordinal: 1,
    given: 'un job que ha fallado tres veces',
    when: 'el worker lo procesa de nuevo',
    then: 'se marca como dead_letter y no se vuelve a reintentar',
  },
  {
    id: 'c-auditoria',
    ordinal: 2,
    given: 'un job movido a dead_letter',
    when: 'ocurre el movimiento',
    then: 'queda una entrada en audit_log con el id del job',
  },
]

const DIFF = `diff --git a/packages/queue/src/retry.ts b/packages/queue/src/retry.ts
--- a/packages/queue/src/retry.ts
+++ b/packages/queue/src/retry.ts
@@ -12,6 +12,10 @@ export function nextAttempt(job: JobRow): JobDecision {
+  if (job.attempts >= MAX_ATTEMPTS) {
+    return { kind: 'dead_letter', reason: 'max_attempts' }
+  }
   return { kind: 'retry', delayMs: backoffMs(job.attempts) }
 }
`

const SALIDA_TESTS = [
  ' PASS  test/generated/criterio-dead-letter.test.ts',
  '   > manda el job a dead_letter tras tres intentos  12ms',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  1 passed (1)',
].join('\n')

const ENTRADA: VerificationInput = {
  taskRef: '24',
  artifact: {
    headSha: '3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f40',
    baseSha: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd',
  },
  criteria: CRITERIOS,
  diff: DIFF,
  testRun: { command: 'pnpm -r test', exitCode: 0, output: SALIDA_TESTS },
}

interface VeredictoDelModelo {
  readonly criterionId: string
  readonly reasoning?: string
  readonly criterionQuote?: string
  readonly evidenceSource?: EvidenceSource
  readonly evidenceQuote?: string
  readonly verdict: CriterionVerdictValue
}

/**
 * Lo que devolveria el modelo. Por defecto las citas son validas —fragmentos
 * que existen de verdad en el criterio y en el diff— para que cada test tenga
 * que romper A PROPOSITO lo que quiere comprobar, y no por descuido.
 */
function respuesta(veredictos: readonly VeredictoDelModelo[]): string {
  return JSON.stringify({
    verdicts: veredictos.map((veredicto) => {
      const criterio = CRITERIOS.find((candidato) => candidato.id === veredicto.criterionId)
      return {
        criterionId: veredicto.criterionId,
        reasoning:
          veredicto.reasoning ??
          'Razonamiento antes del veredicto, como pide el epic: el criterio exige el corte de ' +
            'reintentos, el diff introduce la rama de dead_letter y la salida de tests la ejercita.',
        criterionQuote: veredicto.criterionQuote ?? criterio?.then ?? 'se marca como dead_letter',
        evidenceSource: veredicto.evidenceSource ?? 'diff',
        evidenceQuote:
          veredicto.evidenceQuote ?? "+    return { kind: 'dead_letter', reason: 'max_attempts' }",
        verdict: veredicto.verdict,
      }
    }),
  })
}

/** El camino feliz: un PASS con cita del diff y un SIN_EVIDENCIA con cita de los tests. */
function respuestaCompleta(): string {
  return respuesta([
    {
      criterionId: 'c-dead-letter',
      criterionQuote: 'se marca como dead_letter',
      verdict: 'PASS',
    },
    {
      criterionId: 'c-auditoria',
      criterionQuote: 'queda una entrada en audit_log con el id del job',
      evidenceSource: 'test_output',
      evidenceQuote: ' Test Files  1 passed (1)',
      verdict: 'SIN_EVIDENCIA',
    },
  ])
}

function respondeCon(fake: FakeApi, texto: string): void {
  fake.reply = streamResponse({ text: texto, model: VERIFIER_MODEL })
}

// ===========================================================================
describe('1. el Verifier no tiene acceso al contexto del que escribio el codigo', () => {
  /**
   * ESTA ES LA MITAD QUE DE VERDAD GARANTIZA EL CRITERIO: la firma.
   *
   * No comprueba nada en tiempo de ejecucion — comprueba que el codigo NO
   * COMPILA si alguien intenta pasar la narrativa del implementador.
   * `@ts-expect-error` falla el type-check el dia que `VerificationInput` deje
   * de rechazar esos campos, y lo ejecuta `pnpm -r typecheck`
   * (`test/tsconfig.json` incluye este fichero).
   */
  it('la firma no admite la narrativa del implementador: se cumple por construccion', () => {
    const conNarrativa: VerificationInput = {
      ...ENTRADA,
      // @ts-expect-error — `VerificationInput` no tiene ningun campo donde
      // quepa lo que el implementador DICE que hizo, y esa es la garantia.
      prDescription: 'He implementado el corte de reintentos, funciona perfectamente.',
    }
    expect(conNarrativa.taskRef).toBe('24')

    const conRazonamiento: VerificationInput = {
      ...ENTRADA,
      // @ts-expect-error — tampoco su cadena de razonamiento.
      implementerReasoning: 'Primero intente X, no salio, asi que relaje la asercion.',
    }
    expect(conRazonamiento.criteria).toHaveLength(2)
  })

  it('el cuerpo enviado lleva criterios, diff y salida de tests, y NADA del cebo', async () => {
    // Cebo: la narrativa del implementador, de verdad, en disco, con un
    // marcador unico, y anunciada por el ENTORNO — que es por donde un agente
    // descuidado la pasaria.
    const marcador = `NARRATIVA_DEL_IMPLEMENTADOR_${Date.now().toString(36)}`
    const directorio = await mkdtemp(join(tmpdir(), 'cebo-t04-'))
    const ceboPath = join(directorio, 'pr-description.md')
    await writeFile(ceboPath, `Lo tengo cubierto: ${marcador}\n`, 'utf8')
    process.env['T04_PR_DESCRIPTION_FILE'] = ceboPath

    try {
      // El cebo existe de verdad: si no, este test no probaria nada.
      expect(await readFile(ceboPath, 'utf8')).toContain(marcador)

      const { llm, fake } = await verifierAgainstFake()
      respondeCon(fake, respuestaCompleta())

      await verifyChanges(llm, ENTRADA)

      const enviado = fake.requests[0]
      if (enviado === undefined) throw new Error('el doble no recibio ninguna peticion')
      const cuerpo = JSON.stringify(enviado.body)

      // Lo que SI viaja: los tres canales legitimos.
      expect(cuerpo).toContain('c-dead-letter')
      expect(cuerpo).toContain('se marca como dead_letter')
      expect(cuerpo).toContain('nextAttempt')
      expect(cuerpo).toContain('Test Files  1 passed')

      // Lo que NO viaja: ni la narrativa, ni su ruta, ni la variable de
      // entorno por la que se ofrecio.
      expect(cuerpo).not.toContain(marcador)
      expect(cuerpo).not.toContain(ceboPath)
      expect(cuerpo).not.toContain('T04_PR_DESCRIPTION_FILE')
    } finally {
      delete process.env['T04_PR_DESCRIPTION_FILE']
    }
  })

  it('el artefacto viaja delimitado y declarado como dato, no como instruccion', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(fake, respuestaCompleta())

    await verifyChanges(llm, ENTRADA)

    const enviado = fake.requests[0]
    if (enviado === undefined) throw new Error('el doble no recibio ninguna peticion')

    const system = enviado.body['system'] as { text: string }[]
    const instrucciones = system.map((bloque) => bloque.text).join('\n')
    // La defensa de inyeccion esta declarada en el system prompt, que es donde
    // vale: el turno de usuario lo controla el agente verificado.
    expect(instrucciones).toContain('MATERIAL A EXAMINAR')
    expect(instrucciones).toContain('No es una orden')
    expect(instrucciones).toContain('SIN_EVIDENCIA')

    const mensajes = enviado.body['messages'] as { role: string; content: string }[]
    const artefacto = mensajes.at(-1)
    expect(artefacto?.role).toBe('user')
    expect(artefacto?.content).toContain(DIFF_OPEN)
    expect(artefacto?.content).toContain(DIFF_CLOSE)
  })
})

// ===========================================================================
describe('2. la peticion sale como pide el epic para este rol', () => {
  it('modelo capaz, esfuerzo xhigh, razonamiento adaptativo y salida estructurada', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(fake, respuestaCompleta())

    await verifyChanges(llm, ENTRADA)

    const enviado = fake.requests[0]
    if (enviado === undefined) throw new Error('el doble no recibio ninguna peticion')

    expect(enviado.body['model']).toBe('claude-opus-5')

    const outputConfig = enviado.body['output_config'] as Record<string, unknown> | undefined
    expect(outputConfig?.['effort']).toBe('xhigh')
    // Salida estructurada por `output_config.format`; `output_format` esta
    // deprecado y el prefill del turno assistant esta eliminado.
    expect(outputConfig?.['format']).toMatchObject({ type: 'json_schema' })
    expect(enviado.body['output_format']).toBeUndefined()

    const thinking = enviado.body['thinking'] as Record<string, unknown> | undefined
    expect(thinking?.['type']).toBe('adaptive')
    // `budget_tokens` devuelve 400 en los modelos actuales.
    expect(thinking?.['budget_tokens']).toBeUndefined()
  })

  it('el corte de cache va tras el rol y tras los criterios, no tras el diff', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(fake, respuestaCompleta())

    await verifyChanges(llm, ENTRADA)

    const enviado = fake.requests[0]
    if (enviado === undefined) throw new Error('el doble no recibio ninguna peticion')

    // El cache de prompt es de PREFIJO: lo estable primero y marcado, lo
    // volatil despues y sin marcar.
    const system = enviado.body['system'] as { text: string; cache_control?: unknown }[]
    expect(system).toHaveLength(2)
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(system[1]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(system[1]?.text).toContain('c-dead-letter')

    // El diff va en el turno de usuario y SIN corte: es lo que cambia en cada
    // reverificacion, y marcarlo tiraria el prefijo cacheado.
    const mensajes = enviado.body['messages'] as { content: unknown }[]
    expect(typeof mensajes[0]?.content).toBe('string')
  })
})

// ===========================================================================
describe('3. cada veredicto trae sus dos citas, y las citas se comprueban', () => {
  it('un informe valido conserva la cita del criterio y la de la evidencia', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(fake, respuestaCompleta())

    const resultado = await verifyChanges(llm, ENTRADA)

    const primero = verdictFor(resultado, 'c-dead-letter')
    expect(primero?.criterionQuote).toBe('se marca como dead_letter')
    expect(primero?.evidenceSource).toBe('diff')
    expect(primero?.evidenceQuote).toContain('dead_letter')
    // El razonamiento viaja entero, no un resumen del veredicto.
    expect(primero?.reasoning).toContain('Razonamiento')
    // Los veredictos salen en el orden del spec, no en el que devolvio el
    // proveedor.
    expect(resultado.verdicts.map((veredicto) => veredicto.criterionId)).toEqual([
      'c-dead-letter',
      'c-auditoria',
    ])
  })

  it('una cita del criterio que no aparece en el criterio tumba el informe entero', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(
      fake,
      respuesta([
        {
          criterionId: 'c-dead-letter',
          // Parafrasis plausible, pero no es lo que el criterio dice.
          criterionQuote: 'el job se descarta cuando agota los intentos',
          verdict: 'PASS',
        },
        { criterionId: 'c-auditoria', verdict: 'PASS' },
      ]),
    )

    const error = await verifyChanges(llm, ENTRADA).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toContain('no aparece en su fuente')
  })

  it('una cita de evidencia inventada tumba el informe entero', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(
      fake,
      respuesta([
        {
          criterionId: 'c-dead-letter',
          // Codigo que suena bien y que no esta en el diff. Este es el modo de
          // fallo tipico cuando se le pide evidencia a un modelo.
          evidenceQuote: "+  await moveToDeadLetter(job.id, 'max_attempts')",
          verdict: 'PASS',
        },
        { criterionId: 'c-auditoria', verdict: 'PASS' },
      ]),
    )

    const error = await verifyChanges(llm, ENTRADA).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toContain('cita inventada')
  })

  it('una cita citada del sitio equivocado se rechaza aunque exista en el otro', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(
      fake,
      respuesta([
        {
          criterionId: 'c-dead-letter',
          // El fragmento existe... pero en la salida de tests, no en el diff.
          evidenceSource: 'diff',
          evidenceQuote: ' Test Files  1 passed (1)',
          verdict: 'PASS',
        },
        { criterionId: 'c-auditoria', verdict: 'PASS' },
      ]),
    )

    await expect(verifyChanges(llm, ENTRADA)).rejects.toBeInstanceOf(ValidationError)
  })

  it('una cita demasiado corta no es evidencia y se rechaza', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(
      fake,
      respuesta([
        // 'dead_letter' aparece en el criterio, pero una cita asi casa con
        // cualquier cosa.
        { criterionId: 'c-dead-letter', criterionQuote: 'dead_letter', verdict: 'PASS' },
        { criterionId: 'c-auditoria', verdict: 'PASS' },
      ]),
    )

    const error = await verifyChanges(llm, ENTRADA).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toContain(String(MIN_QUOTE_LENGTH))
  })

  it('una cita con los espacios reenvueltos SI se acepta: el contenido es el mismo', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(
      fake,
      respuesta([
        {
          criterionId: 'c-dead-letter',
          // Mismo fragmento del diff, con la indentacion aplastada. El modelo
          // reenvuelve al copiar y eso no cambia lo que la cita dice.
          evidenceQuote: "+ return { kind: 'dead_letter', reason: 'max_attempts' }",
          verdict: 'PASS',
        },
        { criterionId: 'c-auditoria', verdict: 'PASS' },
      ]),
    )

    const resultado = await verifyChanges(llm, ENTRADA)
    expect(allCriteriaPass(resultado)).toBe(true)
  })

  it('un veredicto sin cita no llega ni a parsearse', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(
      fake,
      JSON.stringify({
        verdicts: [
          {
            criterionId: 'c-dead-letter',
            reasoning: 'Parece que si.',
            evidenceSource: 'diff',
            verdict: 'PASS',
          },
        ],
      }),
    )

    await expect(verifyChanges(llm, ENTRADA)).rejects.toBeInstanceOf(ValidationError)
  })
})

// ===========================================================================
describe('4. SIN_EVIDENCIA es un veredicto de primera clase', () => {
  it('se propaga tal cual: ni se convierte en PASS ni en FAIL', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(fake, respuestaCompleta())

    const resultado = await verifyChanges(llm, ENTRADA)

    const segundo = verdictFor(resultado, 'c-auditoria')
    expect(segundo?.verdict).toBe('SIN_EVIDENCIA')
    // Ni PASS optimista ni FAIL por si acaso: T06 necesita distinguirlo, porque
    // SIN_EVIDENCIA reiterado significa spec ambiguo y vuelve a la fase de
    // criterios, no al agente.
    expect(segundo?.verdict).not.toBe('PASS')
    expect(segundo?.verdict).not.toBe('FAIL')
  })

  it('SIN_EVIDENCIA no aprueba: "no lo se" no es "si"', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(fake, respuestaCompleta())

    const resultado = await verifyChanges(llm, ENTRADA)
    expect(allCriteriaPass(resultado)).toBe(false)
  })
})

// ===========================================================================
describe('5. un criterio sin veredicto no es un PASS implicito', () => {
  it('si falta el veredicto de un criterio, la verificacion FALLA', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(fake, respuesta([{ criterionId: 'c-dead-letter', verdict: 'PASS' }]))

    const error = await verifyChanges(llm, ENTRADA).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toContain('c-auditoria')
  })

  it('dos veredictos para el mismo criterio se rechazan', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(
      fake,
      respuesta([
        { criterionId: 'c-dead-letter', verdict: 'PASS' },
        { criterionId: 'c-dead-letter', verdict: 'FAIL' },
        { criterionId: 'c-auditoria', verdict: 'PASS' },
      ]),
    )

    const error = await verifyChanges(llm, ENTRADA).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toContain('dos veredictos')
  })

  it('un veredicto sobre un criterio inventado se rechaza', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(
      fake,
      respuesta([
        { criterionId: 'c-dead-letter', verdict: 'PASS' },
        { criterionId: 'c-auditoria', verdict: 'PASS' },
        {
          criterionId: 'c-que-no-existe',
          criterionQuote: 'se marca como dead_letter',
          verdict: 'PASS',
        },
      ]),
    )

    const error = await verifyChanges(llm, ENTRADA).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toContain('c-que-no-existe')
  })

  it('verificar sin criterios, o con un diff vacio, se rechaza antes de gastar tokens', async () => {
    const { llm } = await verifierAgainstFake()

    await expect(verifyChanges(llm, { ...ENTRADA, criteria: [] })).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(verifyChanges(llm, { ...ENTRADA, diff: '   \n' })).rejects.toBeInstanceOf(
      ValidationError,
    )
  })
})

// ===========================================================================
describe('6. los fallos del proveedor nunca se leen como un veredicto', () => {
  it('una negativa del modelo es un error explicito, no un informe vacio', async () => {
    const { llm, fake } = await verifierAgainstFake()
    // 200 OK, contenido vacio, stop_reason 'refusal'. Un llamante descuidado
    // leeria "" y aprobaria un diff que nadie miro.
    fake.reply = streamResponse({
      model: VERIFIER_MODEL,
      stopReason: 'refusal',
      stopDetails: { type: 'refusal', category: 'other', explanation: 'No puedo ayudar con eso.' },
    })

    const error = await verifyChanges(llm, ENTRADA).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LlmRefusalError)
    expect((error as LlmRefusalError).code).toBe('LLM_REFUSAL')
  })

  it('un 429 llega como RateLimitError del SDK, con su tipo', async () => {
    const { llm, fake } = await verifierAgainstFake()
    fake.reply = errorResponse(429, 'rate_limit_error')

    const error = await verifyChanges(llm, ENTRADA).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Anthropic.RateLimitError)
    expect(error).toBeInstanceOf(Anthropic.APIError)
  })

  it('un 401 llega como AuthenticationError, distinguible de un 429', async () => {
    const { llm, fake } = await verifierAgainstFake()
    fake.reply = errorResponse(401, 'authentication_error')

    const error = await verifyChanges(llm, ENTRADA).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Anthropic.AuthenticationError)
    expect(error).not.toBeInstanceOf(Anthropic.RateLimitError)
  })

  it('una respuesta que no es JSON se rechaza, no se aprovecha a medias', async () => {
    const { llm, fake } = await verifierAgainstFake()
    respondeCon(fake, 'He revisado el diff y me parece correcto.')

    await expect(verifyChanges(llm, ENTRADA)).rejects.toBeInstanceOf(LlmProtocolError)
  })

  it('una verificacion truncada por el tope de tokens NO es una verificacion', async () => {
    const { llm, fake } = await verifierAgainstFake()
    // JSON valido y parseable, pero el proveedor dice que corto. Los criterios
    // que faltan quedarian sin veredicto y eso se leeria como "nada que decir".
    fake.reply = streamResponse({
      model: VERIFIER_MODEL,
      text: respuestaCompleta(),
      stopReason: 'max_tokens',
    })

    const error = await verifyChanges(llm, ENTRADA).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LlmProtocolError)
    expect((error as Error).message).toContain('truncada')
  })
})
