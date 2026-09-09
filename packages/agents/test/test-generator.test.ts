import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Anthropic from '@anthropic-ai/sdk'
import { LlmRefusalError, ValidationError } from '@coord/core'
import { afterEach, describe, expect, it } from 'vitest'

import { AnthropicLlm, TEST_GENERATOR_MODEL } from '../src/anthropic.js'
import {
  generateTests,
  testsForCriterion,
  type TestGenerationRequest,
  type TraceableCriterion,
} from '../src/verification/test-generator.js'
import {
  errorResponse,
  startFakeApi,
  streamResponse,
  throwawayApiKey,
  type FakeApi,
} from './support/fake-anthropic-api.js'

/**
 * T02 — el generador de tests. Criterios de aceptacion 1 y 3 del epic 05.
 *
 * Contra el doble HTTP local (ver `support/fake-anthropic-api.ts`), no contra
 * un mock del SDK. Y NO contra la API de Anthropic: aqui no hay credenciales y
 * no se intenta. Todo lo que dicen estos tests es sobre la TRADUCCION y las
 * REGLAS del generador, nunca sobre el comportamiento del modelo real.
 */

let api: FakeApi | undefined

afterEach(async () => {
  await api?.close()
  api = undefined
})

async function generatorAgainstFake(): Promise<{ llm: AnthropicLlm; fake: FakeApi }> {
  const fake = await startFakeApi()
  api = fake
  return {
    fake,
    llm: new AnthropicLlm({ apiKey: throwawayApiKey(), baseURL: fake.baseUrl, maxRetries: 0 }),
  }
}

const CRITERIOS: readonly TraceableCriterion[] = [
  {
    id: 'c-uno',
    ordinal: 1,
    given: 'una tarea sin criterios aprobados',
    when: 'un agente intenta reclamarla',
    then: 'el claim se rechaza con `ConflictError`',
  },
  {
    id: 'c-dos',
    ordinal: 2,
    given: 'un cambio en los criterios despues de aprobados',
    when: 'ocurre',
    then: 'queda registrado quien y cuando en `audit_log`',
  },
]

const HASH_CRITERIOS = 'a'.repeat(64)

const PETICION: TestGenerationRequest = {
  taskRef: '22',
  criteria: CRITERIOS,
  criteriaContentHash: HASH_CRITERIOS,
  targetPackage: 'packages/db',
}

/** Lo que devolveria el modelo: un fichero por criterio, cada uno trazado. */
function respuestaCompleta(): string {
  return JSON.stringify({
    files: [
      {
        path: 'packages/db/test/generated/criterio-1-claim-rechazado.test.ts',
        criterionIds: ['c-uno'],
        contents: "// criterio c-uno\nimport { it } from 'vitest'\nit('rechaza', () => {})\n",
      },
      {
        path: 'packages/db/test/generated/criterio-2-auditoria.test.ts',
        criterionIds: ['c-dos'],
        contents: "// criterio c-dos\nimport { it } from 'vitest'\nit('registra', () => {})\n",
      },
    ],
  })
}

function respondeCon(fake: FakeApi, texto: string): void {
  fake.reply = streamResponse({ text: texto, model: TEST_GENERATOR_MODEL })
}

// ===========================================================================
describe('1. el generador no puede ver la implementacion', () => {
  /**
   * PRIMERA MITAD DEL CRITERIO, Y LA QUE DE VERDAD LO GARANTIZA: la firma.
   *
   * Esto no comprueba nada en tiempo de ejecucion — comprueba que el codigo NO
   * COMPILA si alguien intenta pasarle la implementacion. `@ts-expect-error`
   * falla el type-check si la linea de abajo dejase de ser un error, es decir,
   * el dia que alguien abra ese hueco en `TestGenerationRequest`. Lo ejecuta
   * `pnpm -r typecheck` (packages/agents/test/tsconfig.json incluye este
   * fichero).
   */
  it('la firma no admite un campo con el codigo: el criterio se cumple por construccion', () => {
    const conImplementacion: TestGenerationRequest = {
      ...PETICION,
      // @ts-expect-error — `TestGenerationRequest` no tiene ningun campo donde
      // quepa la implementacion, y esa es exactamente la garantia.
      implementationSource: 'export function claim() { return true }',
    }
    // La propiedad sobrante no llega a existir en el tipo: se comprueba que el
    // objeto sigue siendo una peticion valida y nada mas.
    expect(conImplementacion.taskRef).toBe('22')
  })

  it('el cuerpo de la peticion lleva los criterios y NO el contenido del fichero cebo', async () => {
    // Cebo: un fichero de implementacion de verdad, en disco, con un marcador
    // que no aparece en ningun otro sitio, y anunciado por el ENTORNO — que es
    // por donde un agente descuidado lo pasaria.
    const marcador = `MARCADOR_DE_IMPLEMENTACION_${Date.now().toString(36)}`
    const directorio = await mkdtemp(join(tmpdir(), 'cebo-t02-'))
    const ceboPath = join(directorio, 'implementacion.ts')
    await writeFile(ceboPath, `export const secreto = '${marcador}'\n`, 'utf8')
    process.env['T02_IMPLEMENTATION_FILE'] = ceboPath

    try {
      // El cebo existe de verdad: si no, este test no probaria nada.
      expect(await readFile(ceboPath, 'utf8')).toContain(marcador)

      const { llm, fake } = await generatorAgainstFake()
      respondeCon(fake, respuestaCompleta())

      await generateTests(llm, PETICION)

      const enviado = fake.requests[0]
      if (enviado === undefined) throw new Error('el doble no recibio ninguna peticion')
      const cuerpo = JSON.stringify(enviado.body)

      // Lo que SI viaja: los criterios, con su id y su texto.
      expect(cuerpo).toContain('c-uno')
      expect(cuerpo).toContain('el claim se rechaza')
      expect(cuerpo).toContain('queda registrado quien y cuando')

      // Lo que NO viaja: ni el contenido del cebo, ni su ruta, ni el nombre de
      // la variable de entorno por la que se ofrecio.
      //
      // HONESTIDAD SOBRE ESTE CEBO: ninguna ruta del codigo lee jamas
      // `T02_IMPLEMENTATION_FILE`, asi que estas tres aserciones no pueden
      // fallar salvo ante una regresion muy concreta (que alguien anada esa
      // lectura). Son una guardia barata, no la prueba de que no hay fuga. La
      // fuga que SI existia iba por `taskRef` y `targetPackage`, y esa la
      // cubren los dos tests de abajo.
      expect(cuerpo).not.toContain(marcador)
      expect(cuerpo).not.toContain(ceboPath)
      expect(cuerpo).not.toContain('T02_IMPLEMENTATION_FILE')
    } finally {
      delete process.env['T02_IMPLEMENTATION_FILE']
    }
  })

  /**
   * LA FUGA DE VERDAD, LA QUE SI EXISTIA.
   *
   * `taskRef` y `targetPackage` se interpolan LITERALMENTE en el system prompt.
   * Antes eran `string` sin validar: metiendo la implementacion ahi, llegaba
   * integra al cuerpo de la peticion HTTP. La firma cerrada no lo impedia — solo
   * eliminaba el hueco con nombre obvio.
   *
   * Se afirma que la peticion se RECHAZA antes de salir, no que "el codigo no
   * aparece": un test que solo mirase el cuerpo pasaria tambien si la peticion
   * se enviara con el contenido troceado.
   */
  it.each([
    ['taskRef', (implementacion: string) => ({ ...PETICION, taskRef: implementacion })],
    ['targetPackage', (implementacion: string) => ({ ...PETICION, targetPackage: implementacion })],
  ])('la implementacion metida en %s se rechaza y no llega a salir', async (_campo, construir) => {
    const marcador = 'MARCADOR_EN_UN_CAMPO_LIBRE'
    const implementacion = `export function claim() { return '${marcador}' }`

    const { llm, fake } = await generatorAgainstFake()
    respondeCon(fake, respuestaCompleta())

    const error = await generateTests(llm, construir(implementacion)).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ValidationError)
    // Y sobre todo: no se llego a llamar al modelo. El rechazo es ANTES.
    expect(fake.requests).toHaveLength(0)
  })

  it('el id de criterio declarado tiene que aparecer EN el fichero, no solo en criterionIds', async () => {
    const { llm, fake } = await generatorAgainstFake()
    respondeCon(
      fake,
      JSON.stringify({
        files: [
          {
            path: 'packages/db/test/generated/no-menciona-el-criterio.test.ts',
            criterionIds: ['c-uno', 'c-dos'],
            // Declara cubrir los dos y no nombra a ninguno: la trazabilidad
            // seria una afirmacion del propio generador.
            contents: "import { it } from 'vitest'\nit('algo', () => {})\n",
          },
        ],
      }),
    )

    const error = await generateTests(llm, PETICION).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toContain('c-uno')
  })

  it('sale con el modelo del generador (distinto al del implementador) y esfuerzo high', async () => {
    const { llm, fake } = await generatorAgainstFake()
    respondeCon(fake, respuestaCompleta())

    await generateTests(llm, PETICION)

    const enviado = fake.requests[0]
    if (enviado === undefined) throw new Error('el doble no recibio ninguna peticion')
    // El implementador de este repo es Claude Code sobre Opus: el generador
    // TIENE que ser otro modelo (epic 05, T02).
    expect(enviado.body['model']).toBe('claude-sonnet-5')
    expect(enviado.body['model']).not.toBe('claude-opus-5')

    const outputConfig = enviado.body['output_config'] as Record<string, unknown> | undefined
    expect(outputConfig?.['effort']).toBe('high')
    // Salida estructurada por output_config.format; `output_format` esta
    // deprecado y el prefill del assistant esta eliminado.
    expect(outputConfig?.['format']).toMatchObject({ type: 'json_schema' })
    expect(enviado.body['output_format']).toBeUndefined()
    const mensajes = enviado.body['messages'] as { role: string }[]
    expect(mensajes.at(-1)?.role).toBe('user')
  })
})

// ===========================================================================
describe('2. trazabilidad criterio <-> test', () => {
  it('cada criterio acaba con al menos un test, y se puede ir en los dos sentidos', async () => {
    const { llm, fake } = await generatorAgainstFake()
    respondeCon(fake, respuestaCompleta())

    const resultado = await generateTests(llm, PETICION, { now: new Date('2026-09-09T10:00:00Z') })

    // Criterio -> tests.
    for (const criterio of CRITERIOS) {
      expect(testsForCriterion(resultado, criterio.id).length).toBeGreaterThanOrEqual(1)
    }
    // Test -> criterio, sin consultar nada mas: va en el propio fichero y en el
    // manifiesto.
    expect(resultado.files.map((file) => file.criterionIds)).toEqual([['c-uno'], ['c-dos']])
    expect(resultado.manifest.files.map((file) => file.criterionIds)).toEqual([
      ['c-uno'],
      ['c-dos'],
    ])
    expect(resultado.manifest.taskRef).toBe('22')
    expect(resultado.manifest.criteriaContentHash).toBe(HASH_CRITERIOS)
    expect(resultado.manifest.generatorModel).toBe(TEST_GENERATOR_MODEL)
    expect(resultado.manifest.generatedAt).toBe('2026-09-09T10:00:00.000Z')
  })

  it('si un criterio se queda sin test, la generacion FALLA en vez de devolver el resto', async () => {
    const { llm, fake } = await generatorAgainstFake()
    respondeCon(
      fake,
      JSON.stringify({
        files: [
          {
            path: 'packages/db/test/generated/solo-el-primero.test.ts',
            criterionIds: ['c-uno'],
            contents: '// solo cubre c-uno\n',
          },
        ],
      }),
    )

    const error = await generateTests(llm, PETICION).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toContain('c-dos')
  })

  it('un criterionId inventado se rechaza: una trazabilidad falsa es peor que ninguna', async () => {
    const { llm, fake } = await generatorAgainstFake()
    respondeCon(
      fake,
      JSON.stringify({
        files: [
          {
            path: 'packages/db/test/generated/inventado.test.ts',
            criterionIds: ['c-uno', 'c-que-no-existe'],
            contents: '// ...\n',
          },
          {
            path: 'packages/db/test/generated/dos.test.ts',
            criterionIds: ['c-dos'],
            contents: '// ...\n',
          },
        ],
      }),
    )

    const error = await generateTests(llm, PETICION).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toContain('c-que-no-existe')
  })

  it('una ruta fuera del arbol del generador se rechaza antes de escribir nada', async () => {
    const { llm, fake } = await generatorAgainstFake()
    respondeCon(
      fake,
      JSON.stringify({
        files: [
          {
            // El modelo intenta escribir sobre un test escrito a mano.
            path: 'packages/db/test/acceptance-criteria.test.ts',
            criterionIds: ['c-uno', 'c-dos'],
            contents: '// pisar un test existente\n',
          },
        ],
      }),
    )

    const error = await generateTests(llm, PETICION).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toContain('test/generated')
  })

  it('una peticion sin criterios se rechaza: generar sin criterios es teatro', async () => {
    const { llm } = await generatorAgainstFake()
    await expect(generateTests(llm, { ...PETICION, criteria: [] })).rejects.toBeInstanceOf(
      ValidationError,
    )
  })
})

// ===========================================================================
describe('3. los fallos del proveedor no se tragan', () => {
  it('un 429 llega como RateLimitError del SDK, con su tipo', async () => {
    const { llm, fake } = await generatorAgainstFake()
    fake.reply = errorResponse(429, 'rate_limit_error')

    const error = await generateTests(llm, PETICION).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Anthropic.RateLimitError)
    expect(error).toBeInstanceOf(Anthropic.APIError)
  })

  it('un 400 llega como BadRequestError, no como RateLimitError', async () => {
    const { llm, fake } = await generatorAgainstFake()
    fake.reply = errorResponse(400, 'invalid_request_error')

    const error = await generateTests(llm, PETICION).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Anthropic.BadRequestError)
    expect(error).not.toBeInstanceOf(Anthropic.RateLimitError)
  })

  it('una negativa del modelo es un fallo explicito, no cero tests generados', async () => {
    const { llm, fake } = await generatorAgainstFake()
    // 200 OK, contenido vacio, stop_reason 'refusal'. Un llamante descuidado
    // leeria "" y concluiria "la tarea no necesitaba tests".
    fake.reply = streamResponse({
      model: TEST_GENERATOR_MODEL,
      stopReason: 'refusal',
      stopDetails: { type: 'refusal', category: 'other', explanation: 'No puedo ayudar con eso.' },
    })

    const error = await generateTests(llm, PETICION).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LlmRefusalError)
    expect((error as LlmRefusalError).code).toBe('LLM_REFUSAL')
  })

  it('una respuesta que no encaja con el esquema pedido se rechaza', async () => {
    const { llm, fake } = await generatorAgainstFake()
    respondeCon(fake, JSON.stringify({ files: [{ path: 'x', criterionIds: [] }] }))

    const error = await generateTests(llm, PETICION).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ValidationError)
  })
})
