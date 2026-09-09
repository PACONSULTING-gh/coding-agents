import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { ValidationError } from '@coord/core'
import { afterEach, describe, expect, it } from 'vitest'

import { AnthropicLlm, TEST_GENERATOR_MODEL } from '../src/anthropic.js'
import {
  collectGeneratedTestsOnDisk,
  readGeneratedTestsManifest,
  readSigningKeyFromEnv,
  verifyGeneratedTestsOnDisk,
  writeGeneratedTests,
  writeGeneratedTestsManifest,
} from '../src/verification/generated-tests-fs.js'
import { generateTests, type TestGenerationRequest } from '../src/verification/test-generator.js'
import {
  assertGeneratedTestPath,
  buildTaskManifest,
  canonicalJson,
  GENERATED_TESTS_MANIFEST_PATH,
  GENERATED_TESTS_SIGNING_KEY_ENV,
  parseManifest,
  serializeManifest,
  signManifest,
  upsertTaskManifest,
  verifyGeneratedTests,
  EMPTY_GENERATED_TESTS_MANIFEST,
  type GeneratedTestsManifest,
} from '../src/verification/test-manifest.js'
import {
  GeneratedTestsTamperedError,
  assertGeneratedTestsUntampered,
} from '../src/verification/tamper-audit.js'
import {
  startFakeApi,
  streamResponse,
  throwawayApiKey,
  type FakeApi,
} from './support/fake-anthropic-api.js'

/**
 * T02 — segundo criterio de aceptacion: "cuando el agente implementador intenta
 * modificar ficheros de test, el intento se bloquea y se registra".
 *
 * Este fichero cubre la DETECCION y el BLOQUEO. El registro en `audit_log` esta
 * en `tamper-audit.test.ts`, que necesita Postgres.
 *
 * ---------------------------------------------------------------------------
 * LO QUE ESTOS TESTS NO DEMUESTRAN
 * ---------------------------------------------------------------------------
 * No demuestran que un agente NO PUEDA escribir en `test/generated/`. Puede:
 * corre con el usuario del desarrollador y escribe donde quiere. Lo que se
 * comprueba aqui es que, si lo hace, el gate LO CAZA de forma determinista y
 * sale con codigo 1. Esa es toda la garantia que hay, y presentarla como otra
 * cosa seria mentir sobre un gate.
 */

const run = promisify(execFile)

/** packages/agents/test -> packages/agents */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI = join(PACKAGE_ROOT, 'dist', 'verification', 'verify-generated-tests-cli.js')

const RUTA_UNO = 'packages/db/test/generated/criterio-1.test.ts'
const RUTA_DOS = 'packages/db/test/generated/criterio-2.test.ts'
const CONTENIDO_UNO = "// criterio c-uno\nimport { it } from 'vitest'\nit('uno', () => {})\n"
const CONTENIDO_DOS = "// criterio c-dos\nimport { it } from 'vitest'\nit('dos', () => {})\n"
const HASH_CRITERIOS = 'a'.repeat(64)
const OTRO_HASH_CRITERIOS = 'b'.repeat(64)

const directorios: string[] = []
const servidores: FakeApi[] = []

afterEach(async () => {
  for (const directorio of directorios.splice(0)) {
    await rm(directorio, { recursive: true, force: true })
  }
  for (const servidor of servidores.splice(0)) {
    await servidor.close()
  }
})

async function repoTemporal(): Promise<string> {
  const directorio = await mkdtemp(join(tmpdir(), 'repo-t02-'))
  directorios.push(directorio)
  return directorio
}

/** Clave aleatoria por ejecucion. En el repositorio no hay ninguna (CLAUDE.md 5). */
function claveDeFirma(): string {
  return randomBytes(32).toString('hex')
}

function manifiestoDeDosFicheros(): GeneratedTestsManifest {
  return upsertTaskManifest(
    EMPTY_GENERATED_TESTS_MANIFEST,
    buildTaskManifest({
      taskRef: '22',
      criteriaContentHash: HASH_CRITERIOS,
      generatorModel: TEST_GENERATOR_MODEL,
      generatedAt: new Date('2026-09-09T10:00:00Z'),
      files: [
        { path: RUTA_UNO, contents: CONTENIDO_UNO, criterionIds: ['c-uno'] },
        { path: RUTA_DOS, contents: CONTENIDO_DOS, criterionIds: ['c-dos'] },
      ],
    }),
  )
}

const EN_DISCO_INTACTO = new Map([
  [RUTA_UNO, CONTENIDO_UNO],
  [RUTA_DOS, CONTENIDO_DOS],
])

// ===========================================================================
describe('1. la ruta convenida', () => {
  it('acepta una ruta dentro del arbol del generador', () => {
    expect(() => {
      assertGeneratedTestPath('packages/db/test/generated/sub/criterio-3.test.ts')
    }).not.toThrow()
    expect(() => {
      assertGeneratedTestPath('apps/worker/test/generated/criterio-3.test.ts')
    }).not.toThrow()
  })

  it.each([
    ['un test escrito a mano', 'packages/db/test/acceptance-criteria.test.ts'],
    ['una escapada con ..', 'packages/db/test/generated/../../src/client.ts'],
    ['una ruta absoluta', '/etc/passwd'],
    ['codigo fuente disfrazado', 'packages/db/test/generated/client.ts'],
    ['otro arbol', 'tests/generated/criterio-1.test.ts'],
  ])('rechaza %s', (_caso, ruta) => {
    expect(() => {
      assertGeneratedTestPath(ruta)
    }).toThrow(ValidationError)
  })
})

// ===========================================================================
describe('2. deteccion de manipulacion', () => {
  it('un arbol intacto no dispara ningun hallazgo', () => {
    const resultado = verifyGeneratedTests({
      signed: { manifest: manifiestoDeDosFicheros() },
      filesOnDisk: EN_DISCO_INTACTO,
    })
    expect(resultado.findings).toEqual([])
    expect(resultado.ok).toBe(true)
    expect(resultado.filesChecked).toBe(2)
  })

  it('un solo caracter cambiado en un test se detecta', () => {
    const resultado = verifyGeneratedTests({
      signed: { manifest: manifiestoDeDosFicheros() },
      filesOnDisk: new Map([
        // Debilitar una asercion es una de las trampas documentadas del epic.
        [RUTA_UNO, CONTENIDO_UNO.replace("it('uno'", "it.skip('uno'")], // dato de prueba del detector, no un skip real
        [RUTA_DOS, CONTENIDO_DOS],
      ]),
    })
    expect(resultado.ok).toBe(false)
    expect(resultado.findings).toHaveLength(1)
    expect(resultado.findings[0]?.kind).toBe('modified')
    expect(resultado.findings[0]?.path).toBe(RUTA_UNO)
  })

  it('borrar un test generado se detecta como `missing`, no como "nada que comprobar"', () => {
    const resultado = verifyGeneratedTests({
      signed: { manifest: manifiestoDeDosFicheros() },
      filesOnDisk: new Map([[RUTA_DOS, CONTENIDO_DOS]]),
    })
    expect(resultado.findings.map((finding) => finding.kind)).toEqual(['missing'])
    expect(resultado.findings[0]?.path).toBe(RUTA_UNO)
  })

  it('un fichero colado en el arbol del generador se detecta como `untracked`', () => {
    const resultado = verifyGeneratedTests({
      signed: { manifest: manifiestoDeDosFicheros() },
      filesOnDisk: new Map([
        ...EN_DISCO_INTACTO,
        ['packages/db/test/generated/colado.test.ts', 'it("siempre verde", () => {})'],
      ]),
    })
    expect(resultado.findings.map((finding) => finding.kind)).toEqual(['untracked'])
  })

  it('regenerar de verdad NO dispara la alarma (el caso negativo)', () => {
    const regenerado = upsertTaskManifest(
      manifiestoDeDosFicheros(),
      buildTaskManifest({
        taskRef: '22',
        criteriaContentHash: OTRO_HASH_CRITERIOS,
        generatorModel: TEST_GENERATOR_MODEL,
        files: [
          { path: RUTA_UNO, contents: `${CONTENIDO_UNO}// otra vuelta\n`, criterionIds: ['c-uno'] },
          { path: RUTA_DOS, contents: CONTENIDO_DOS, criterionIds: ['c-dos'] },
        ],
      }),
    )
    const resultado = verifyGeneratedTests({
      signed: { manifest: regenerado },
      filesOnDisk: new Map([
        [RUTA_UNO, `${CONTENIDO_UNO}// otra vuelta\n`],
        [RUTA_DOS, CONTENIDO_DOS],
      ]),
      currentCriteriaHashes: new Map([['22', OTRO_HASH_CRITERIOS]]),
    })
    expect(resultado.findings).toEqual([])
    expect(resultado.ok).toBe(true)
    // Y la regeneracion sustituye el bloque de la tarea, no lo duplica.
    expect(regenerado.tasks).toHaveLength(1)
  })

  it('criterios cambiados y tests sin regenerar: `criteria_drifted`', () => {
    const resultado = verifyGeneratedTests({
      signed: { manifest: manifiestoDeDosFicheros() },
      filesOnDisk: EN_DISCO_INTACTO,
      currentCriteriaHashes: new Map([['22', OTRO_HASH_CRITERIOS]]),
    })
    expect(resultado.findings.map((finding) => finding.kind)).toEqual(['criteria_drifted'])
    expect(resultado.findings[0]?.taskRef).toBe('22')
  })
})

// ===========================================================================
describe('3. la firma, que es lo unico que para a un agente', () => {
  it('un manifiesto firmado y sin tocar verifica, y `signatureChecked` lo dice', () => {
    const clave = claveDeFirma()
    const resultado = verifyGeneratedTests({
      signed: signManifest(manifiestoDeDosFicheros(), clave),
      filesOnDisk: EN_DISCO_INTACTO,
      signingKey: clave,
    })
    expect(resultado.ok).toBe(true)
    expect(resultado.signatureChecked).toBe(true)
  })

  it('reescribir el test Y su hash en el manifiesto no cuela: la firma no cuadra', () => {
    const clave = claveDeFirma()
    const firmado = signManifest(manifiestoDeDosFicheros(), clave)

    // Justo lo que haria un agente que quiere que su edicion pase el gate:
    // cambia el test y ajusta el hash para que cuadre.
    const contenidoDebilitado = CONTENIDO_UNO.replace("it('uno'", "it.skip('uno'") // dato de prueba del detector, no un skip real
    const falsificado = upsertTaskManifest(
      firmado.manifest,
      buildTaskManifest({
        taskRef: '22',
        criteriaContentHash: HASH_CRITERIOS,
        generatorModel: TEST_GENERATOR_MODEL,
        files: [
          { path: RUTA_UNO, contents: contenidoDebilitado, criterionIds: ['c-uno'] },
          { path: RUTA_DOS, contents: CONTENIDO_DOS, criterionIds: ['c-dos'] },
        ],
      }),
    )

    const resultado = verifyGeneratedTests({
      // Se conserva la firma vieja: el agente no tiene la clave para recalcularla.
      signed: {
        manifest: falsificado,
        ...(firmado.signature ? { signature: firmado.signature } : {}),
      },
      filesOnDisk: new Map([
        [RUTA_UNO, contenidoDebilitado],
        [RUTA_DOS, CONTENIDO_DOS],
      ]),
      signingKey: clave,
    })

    // Los hashes cuadran (por eso no hay `modified`) y aun asi se caza.
    expect(resultado.findings.map((finding) => finding.kind)).toEqual(['signature_invalid'])
    expect(resultado.ok).toBe(false)
  })

  it('con clave configurada, un manifiesto sin firmar es un hallazgo', () => {
    const resultado = verifyGeneratedTests({
      signed: { manifest: manifiestoDeDosFicheros() },
      filesOnDisk: EN_DISCO_INTACTO,
      signingKey: claveDeFirma(),
    })
    expect(resultado.findings.map((finding) => finding.kind)).toEqual(['signature_missing'])
  })

  it('SIN clave, `signatureChecked` es false: verde aqui NO significa "nadie lo ha tocado"', () => {
    const resultado = verifyGeneratedTests({
      signed: signManifest(manifiestoDeDosFicheros(), claveDeFirma()),
      filesOnDisk: EN_DISCO_INTACTO,
    })
    expect(resultado.ok).toBe(true)
    expect(resultado.signatureChecked).toBe(false)
  })

  it('otra clave no valida la firma', () => {
    const resultado = verifyGeneratedTests({
      signed: signManifest(manifiestoDeDosFicheros(), claveDeFirma()),
      filesOnDisk: EN_DISCO_INTACTO,
      signingKey: claveDeFirma(),
    })
    expect(resultado.findings.map((finding) => finding.kind)).toEqual(['signature_invalid'])
  })

  it('firmar sin clave se rechaza en vez de producir una firma inutil', () => {
    expect(() => signManifest(manifiestoDeDosFicheros(), '   ')).toThrow(ValidationError)
  })

  it('la firma no depende del orden en que se construyo el objeto', () => {
    const clave = claveDeFirma()
    const manifiesto = manifiestoDeDosFicheros()
    const reordenado = JSON.parse(
      JSON.stringify({ tasks: manifiesto.tasks, version: manifiesto.version }),
    ) as GeneratedTestsManifest
    expect(canonicalJson(reordenado)).toBe(canonicalJson(manifiesto))
    expect(signManifest(reordenado, clave).signature).toEqual(
      signManifest(manifiesto, clave).signature,
    )
  })

  it('el manifiesto se serializa y se vuelve a leer sin perder la firma', () => {
    const clave = claveDeFirma()
    const firmado = signManifest(manifiestoDeDosFicheros(), clave)
    const releido = parseManifest(serializeManifest(firmado))
    expect(releido).toEqual(firmado)
  })

  it('un manifiesto ilegible se rechaza en voz alta, no se ignora', () => {
    expect(() => parseManifest('{ esto no es json')).toThrow(ValidationError)
    // Una ruta fuera del arbol dentro del propio manifiesto tampoco pasa.
    expect(() =>
      parseManifest(
        JSON.stringify({
          version: 1,
          tasks: [
            {
              taskRef: '22',
              criteriaContentHash: HASH_CRITERIOS,
              generatorModel: 'x',
              generatedAt: '2026-09-09T10:00:00.000Z',
              files: [
                { path: 'packages/db/src/client.ts', sha256: 'c'.repeat(64), criterionIds: ['c'] },
              ],
            },
          ],
        }),
      ),
    ).toThrow(ValidationError)
  })
})

// ===========================================================================
describe('4. contra el disco de verdad', () => {
  it('escribir, verificar, manipular y volver a verificar', async () => {
    const repo = await repoTemporal()
    const clave = claveDeFirma()

    const fake = await startFakeApi()
    servidores.push(fake)
    fake.reply = streamResponse({
      model: TEST_GENERATOR_MODEL,
      text: JSON.stringify({
        files: [
          { path: RUTA_UNO, criterionIds: ['c-uno'], contents: CONTENIDO_UNO },
          { path: RUTA_DOS, criterionIds: ['c-dos'], contents: CONTENIDO_DOS },
        ],
      }),
    })
    const llm = new AnthropicLlm({
      apiKey: throwawayApiKey(),
      baseURL: fake.baseUrl,
      maxRetries: 0,
    })
    const peticion: TestGenerationRequest = {
      taskRef: '22',
      criteria: [
        { id: 'c-uno', ordinal: 1, given: 'g', when: 'w', then: 'devuelve 1' },
        { id: 'c-dos', ordinal: 2, given: 'g', when: 'w', then: 'registra en `audit_log`' },
      ],
      criteriaContentHash: HASH_CRITERIOS,
      targetPackage: 'packages/db',
    }

    const generado = await generateTests(llm, peticion)
    await writeGeneratedTests({ repoRoot: repo, result: generado, signingKey: clave })

    // Se escribio donde toca y con lo que toca.
    expect(await readFile(join(repo, RUTA_UNO), 'utf8')).toBe(CONTENIDO_UNO)
    await access(join(repo, ...GENERATED_TESTS_MANIFEST_PATH.split('/')))
    expect([...(await collectGeneratedTestsOnDisk(repo)).keys()].sort()).toEqual([
      RUTA_UNO,
      RUTA_DOS,
    ])

    const limpio = await verifyGeneratedTestsOnDisk({ repoRoot: repo, signingKey: clave })
    expect(limpio.manifestPresent).toBe(true)
    expect(limpio.findings).toEqual([])
    expect(() => {
      assertGeneratedTestsUntampered(limpio)
    }).not.toThrow()

    // Ahora el implementador toca un test generado.
    await writeFile(join(repo, RUTA_UNO), `${CONTENIDO_UNO}// tocado a mano\n`, 'utf8')
    const sucio = await verifyGeneratedTestsOnDisk({ repoRoot: repo, signingKey: clave })
    expect(sucio.findings.map((finding) => finding.kind)).toEqual(['modified'])

    const error = (() => {
      try {
        assertGeneratedTestsUntampered(sucio)
        return undefined
      } catch (caught: unknown) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(GeneratedTestsTamperedError)
    expect((error as GeneratedTestsTamperedError).code).toBe('CONFLICT')
    expect((error as GeneratedTestsTamperedError).findings).toHaveLength(1)
  })

  it('sin manifiesto y sin ficheros no hay nada que comprobar; con ficheros, si', async () => {
    const repo = await repoTemporal()
    const vacio = await verifyGeneratedTestsOnDisk({ repoRoot: repo })
    expect(vacio.manifestPresent).toBe(false)
    expect(vacio.ok).toBe(true)

    // Un fichero en el arbol del generador SIN manifiesto no es "nada que
    // comprobar": lo puso alguien que no era el generador.
    await mkdir(join(repo, 'packages', 'db', 'test', 'generated'), { recursive: true })
    await writeFile(join(repo, RUTA_UNO), CONTENIDO_UNO, 'utf8')

    const conFicheros = await verifyGeneratedTestsOnDisk({ repoRoot: repo })
    expect(conFicheros.manifestPresent).toBe(false)
    expect(conFicheros.ok).toBe(false)
    expect(conFicheros.findings.map((finding) => finding.kind)).toEqual(['untracked'])
  })

  it('la clave sale del entorno y una vacia cuenta como ausente', () => {
    expect(readSigningKeyFromEnv({})).toBeUndefined()
    expect(readSigningKeyFromEnv({ [GENERATED_TESTS_SIGNING_KEY_ENV]: '   ' })).toBeUndefined()
    expect(readSigningKeyFromEnv({ [GENERATED_TESTS_SIGNING_KEY_ENV]: 'abc' })).toBe('abc')
  })

  it('readGeneratedTestsManifest devuelve undefined cuando no hay fichero', async () => {
    expect(await readGeneratedTestsManifest(await repoTemporal())).toBeUndefined()
  })
})

// ===========================================================================
describe('5. el CLI: el codigo de salida ES la barrera', () => {
  /**
   * Se ejecuta el CLI construido, como proceso, porque lo que bloquea el CI no
   * es que una funcion devuelva `ok: false` sino que el proceso salga con
   * codigo 1. Necesita `pnpm -r build` antes (el job de CI ya lo hace).
   */
  async function cli(repoRoot: string): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      await access(CLI)
    } catch (error) {
      throw new Error(
        `Falta ${CLI}. Este test ejecuta el CLI construido: corre \`pnpm -r build\` antes.`,
        { cause: error },
      )
    }
    try {
      const { stdout, stderr } = await run(process.execPath, [CLI, '--root', repoRoot], {
        env: { ...process.env, [GENERATED_TESTS_SIGNING_KEY_ENV]: '' },
      })
      return { code: 0, stdout, stderr }
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string }
      return {
        code: failure.code ?? -1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      }
    }
  }

  it('sale con 0 y avisa de que la firma no se comprobo cuando no hay clave', async () => {
    const repo = await repoTemporal()
    await mkdir(join(repo, 'packages', 'db', 'test', 'generated'), { recursive: true })
    await writeFile(join(repo, RUTA_UNO), CONTENIDO_UNO, 'utf8')
    await writeFile(join(repo, RUTA_DOS), CONTENIDO_DOS, 'utf8')
    await writeGeneratedTestsManifest(repo, { manifest: manifiestoDeDosFicheros() })

    const resultado = await cli(repo)
    expect(resultado.code).toBe(0)
    expect(resultado.stderr).toContain('firma NO comprobada')
  })

  it('sale con 1 y nombra el fichero cuando un test generado se toco', async () => {
    const repo = await repoTemporal()
    await mkdir(join(repo, 'packages', 'db', 'test', 'generated'), { recursive: true })
    await writeFile(join(repo, RUTA_UNO), `${CONTENIDO_UNO}// tocado\n`, 'utf8')
    await writeFile(join(repo, RUTA_DOS), CONTENIDO_DOS, 'utf8')
    await writeGeneratedTestsManifest(repo, { manifest: manifiestoDeDosFicheros() })

    const resultado = await cli(repo)
    expect(resultado.code).toBe(1)
    expect(resultado.stderr).toContain(RUTA_UNO)
    expect(resultado.stderr).toContain('modified')
  })
})
