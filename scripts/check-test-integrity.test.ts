import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

/**
 * Tests del gate de integridad de tests (T03, epic 05, issue #23).
 *
 * ===========================================================================
 * POR QUE ESTE FICHERO EXISTE
 * ===========================================================================
 * `scripts/check-test-integrity.mjs` es el que hace cumplir "un PR que borra o
 * debilita aserciones se bloquea", y NO TENIA NI UN TEST. Sus detectores son
 * regex y un parser de unified diff escrito a mano: cuando uno se rompe, el
 * sintoma es SILENCIOSO —el gate deja de bloquear, no falla— que es la peor
 * forma posible de romperse para un gate.
 *
 * Cada caso monta un repositorio git REAL en un directorio temporal (nada de
 * simular `git diff`: lo que se comprueba es el comportamiento del script contra
 * git de verdad, CLAUDE.md 5), fabrica el diff de la trampa correspondiente y
 * afirma el codigo de salida Y el texto del hallazgo.
 *
 * Los casos que salen en VERDE son tan importantes como los rojos: fijan las
 * limitaciones declaradas del gate, de modo que el dia que alguien las cierre,
 * el cambio de comportamiento se ve en el diff en vez de descubrirse en
 * produccion.
 */

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'check-test-integrity.mjs')

const directorios: string[] = []

afterEach(async () => {
  await Promise.all(directorios.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** Un repositorio con una rama `base` y una rama `head` sobre la que se diffea. */
async function repoConBase(ficheros: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gate-t03-'))
  directorios.push(dir)
  git(dir, 'init', '--quiet', '--initial-branch', 'base')
  git(dir, 'config', 'user.email', 'gate@example.invalid')
  git(dir, 'config', 'user.name', 'Gate Test')
  await escribir(dir, ficheros)
  git(dir, 'add', '-A')
  git(dir, 'commit', '--quiet', '-m', 'Issue #23: base')
  git(dir, 'checkout', '--quiet', '-b', 'head')
  return dir
}

async function escribir(dir: string, ficheros: Record<string, string>): Promise<void> {
  for (const [ruta, contenido] of Object.entries(ficheros)) {
    const absoluta = join(dir, ruta)
    await mkdir(dirname(absoluta), { recursive: true })
    await writeFile(absoluta, contenido, 'utf8')
  }
}

interface Resultado {
  readonly exitCode: number
  readonly output: string
}

/** Aplica el cambio sobre `head`, lo commitea y corre el gate. */
async function correrGate(
  dir: string,
  cambio: { ficheros?: Record<string, string>; borrar?: string[] },
  mensaje = 'Issue #23: cambio',
): Promise<Resultado> {
  if (cambio.ficheros) await escribir(dir, cambio.ficheros)
  for (const ruta of cambio.borrar ?? []) git(dir, 'rm', '--quiet', ruta)
  git(dir, 'add', '-A')
  git(dir, 'commit', '--quiet', '-m', mensaje)

  try {
    const output = execFileSync('node', [SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, TEST_INTEGRITY_BASE_REF: 'base', TEST_INTEGRITY_HEAD_REF: 'HEAD' },
    })
    return { exitCode: 0, output }
  } catch (error) {
    const fallo = error as { status?: number; stdout?: string; stderr?: string }
    return { exitCode: fallo.status ?? -1, output: `${fallo.stdout ?? ''}${fallo.stderr ?? ''}` }
  }
}

const TEST_CON_ASERCIONES = `import { describe, expect, it } from 'vitest'

describe('claims', () => {
  it('devuelve el titular', () => {
    expect(claim.holderId).toEqual('agente-1')
    expect(claim.holderLabel).toBe('Ana')
    expect(claim.files).toHaveLength(3)
  })
})
`

// ===========================================================================
describe('1. lo que el gate BLOQUEA', () => {
  it('un fichero de test borrado', async () => {
    const dir = await repoConBase({ 'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES })
    const resultado = await correrGate(dir, { borrar: ['packages/db/test/claims.test.ts'] })

    expect(resultado.exitCode).toBe(1)
    expect(resultado.output).toContain('fichero de test borrado')
    expect(resultado.output).toContain('packages/db/test/claims.test.ts')
  })

  it('aserciones que desaparecen sin que nada las compense', async () => {
    const dir = await repoConBase({ 'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES })
    const resultado = await correrGate(dir, {
      ficheros: {
        'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES.replace(
          "    expect(claim.holderLabel).toBe('Ana')\n    expect(claim.files).toHaveLength(3)\n",
          '',
        ),
      },
    })

    expect(resultado.exitCode).toBe(1)
    expect(resultado.output).toContain('aserciones totales bajan')
  })

  /**
   * EL AGUJERO QUE ESTE PR CIERRA (1 de 2). Antes salia exit 0: el fichero
   * seguia ahi, el conteo de `expect(` no se movia y los tests seguian verdes.
   */
  it('el matcher pasa de concreto a permisivo sobre el mismo sujeto', async () => {
    const dir = await repoConBase({ 'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES })
    const resultado = await correrGate(dir, {
      ficheros: {
        'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES.replace(
          "expect(claim.holderId).toEqual('agente-1')",
          'expect(claim.holderId).toBeDefined()',
        ),
      },
    })

    expect(resultado.exitCode).toBe(1)
    expect(resultado.output).toContain('asercion debilitada')
    expect(resultado.output).toContain('toEqual')
    expect(resultado.output).toContain('toBeDefined')
  })

  /**
   * EL AGUJERO QUE ESTE PR CIERRA (2 de 2). Vaciar un fichero real y compensar
   * el total con relleno en un fichero NUEVO salia exit 0.
   */
  it('un fichero preexistente se vacia y un fichero nuevo compensa el total', async () => {
    const dir = await repoConBase({ 'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES })
    const relleno = [
      "import { expect, it } from 'vitest'",
      '',
      ...Array.from(
        { length: 4 },
        (_unused, i) => `it('relleno ${String(i)}', () => { expect(${String(i)}).toBeDefined() })`,
      ),
      '',
    ].join('\n')
    const resultado = await correrGate(dir, {
      ficheros: {
        'packages/db/test/claims.test.ts':
          "import { describe } from 'vitest'\ndescribe('claims', () => {})\n",
        'packages/db/test/relleno.test.ts': relleno,
      },
    })

    expect(resultado.exitCode).toBe(1)
    expect(resultado.output).toContain('PREEXISTENTES')
  })

  it('una asercion vacua anadida', async () => {
    const dir = await repoConBase({ 'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES })
    const resultado = await correrGate(dir, {
      ficheros: {
        'packages/db/test/claims.test.ts': `${TEST_CON_ASERCIONES}\nit('nuevo', () => { expect(true).toBe(true) })\n`,
      },
    })

    expect(resultado.exitCode).toBe(1)
    expect(resultado.output).toContain('asercion vacua')
  })

  it('un it.skip sin comentario que lo justifique', async () => {
    const dir = await repoConBase({ 'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES })
    const resultado = await correrGate(dir, {
      ficheros: {
        'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES.replace(
          "  it('devuelve el titular'",
          "  it.skip('devuelve el titular'",
        ),
      },
    })

    expect(resultado.exitCode).toBe(1)
    expect(resultado.output).toContain('.skip( anadido sin comentario')
  })

  it('un umbral numerico que baja dentro de un test', async () => {
    const conUmbral =
      "import { expect, it } from 'vitest'\nit('p95', () => {\n  expect(score).toBeGreaterThan(80)\n})\n"
    const dir = await repoConBase({ 'packages/db/test/latencia.test.ts': conUmbral })
    const resultado = await correrGate(dir, {
      ficheros: {
        'packages/db/test/latencia.test.ts': conUmbral.replace(
          'toBeGreaterThan(80)',
          'toBeGreaterThan(10)',
        ),
      },
    })

    expect(resultado.exitCode).toBe(1)
    expect(resultado.output).toContain('umbral bajado')
  })

  it('el umbral de mutacion bajado en stryker.config.json', async () => {
    const config = JSON.stringify(
      { mutate: ['packages/core/src/tenant.ts'], thresholds: { high: 80, low: 60, break: 60 } },
      null,
      2,
    )
    const dir = await repoConBase({ 'stryker.config.json': config })
    const resultado = await correrGate(dir, {
      ficheros: { 'stryker.config.json': config.replace('"break": 60', '"break": 10') },
    })

    expect(resultado.exitCode).toBe(1)
    expect(resultado.output).toContain('thresholds.break 60 -> 10')
  })

  /** El umbral intacto y el modulo fuera de la medida: el mismo fraude por la otra puerta. */
  it('un modulo que desaparece de la lista `mutate` de Stryker', async () => {
    const config = JSON.stringify(
      {
        mutate: ['packages/core/src/tenant.ts', 'packages/db/src/client.ts'],
        thresholds: { high: 80, low: 60, break: 60 },
      },
      null,
      2,
    )
    const dir = await repoConBase({ 'stryker.config.json': config })
    const resultado = await correrGate(dir, {
      ficheros: {
        'stryker.config.json': JSON.stringify(
          { mutate: ['packages/core/src/tenant.ts'], thresholds: { high: 80, low: 60, break: 60 } },
          null,
          2,
        ),
      },
    })

    expect(resultado.exitCode).toBe(1)
    expect(resultado.output).toContain('packages/db/src/client.ts')
    expect(resultado.output).toContain('mutate')
  })

  it('un job que sale de la lista `needs` de ci-ok', async () => {
    const ci =
      'jobs:\n  ci-ok:\n    needs: [lint, test, test-integrity]\n    steps:\n      - run: node scripts/check-test-integrity.mjs\n'
    const dir = await repoConBase({ '.github/workflows/ci.yml': ci })
    const resultado = await correrGate(dir, {
      ficheros: {
        '.github/workflows/ci.yml': ci.replace('[lint, test, test-integrity]', '[lint, test]'),
      },
    })

    expect(resultado.exitCode).toBe(1)
    expect(resultado.output).toContain('test-integrity')
    expect(resultado.output).toContain('needs')
  })

  it('el CI deja de invocar el propio script del gate', async () => {
    const ci =
      'jobs:\n  ci-ok:\n    needs: [lint, test-integrity]\n    steps:\n      - run: node scripts/check-test-integrity.mjs\n'
    const dir = await repoConBase({ '.github/workflows/ci.yml': ci })
    const resultado = await correrGate(dir, {
      ficheros: {
        '.github/workflows/ci.yml': ci.replace('node scripts/check-test-integrity.mjs', 'echo ok'),
      },
    })

    expect(resultado.exitCode).toBe(1)
    expect(resultado.output).toContain('deja de invocar')
  })

  it('el manifiesto de los tests generados borrado', async () => {
    const dir = await repoConBase({
      'verification/generated-tests.manifest.json': '{"manifest":{"version":1,"tasks":[]}}',
    })
    const resultado = await correrGate(dir, {
      borrar: ['verification/generated-tests.manifest.json'],
    })

    expect(resultado.exitCode).toBe(1)
    expect(resultado.output).toContain('generated-tests.manifest.json')
  })

  it('un .spec.ts tambien esta cubierto, no solo los .test.ts', async () => {
    const dir = await repoConBase({ 'packages/db/test/claims.spec.ts': TEST_CON_ASERCIONES })
    const resultado = await correrGate(dir, { borrar: ['packages/db/test/claims.spec.ts'] })

    expect(resultado.exitCode).toBe(1)
    expect(resultado.output).toContain('claims.spec.ts')
  })
})

// ===========================================================================
describe('2. la via de escape auditable', () => {
  it('el trailer de override deja pasar el hallazgo y lo deja escrito con su SHA', async () => {
    const dir = await repoConBase({ 'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES })
    const resultado = await correrGate(
      dir,
      { borrar: ['packages/db/test/claims.test.ts'] },
      'Issue #23: se retira el modulo entero\n\nTest-Integrity-Override: el modulo que probaba ya no existe',
    )

    expect(resultado.exitCode).toBe(0)
    // El hallazgo NO se oculta: sale igual, y con el motivo firmado al lado.
    expect(resultado.output).toContain('fichero de test borrado')
    expect(resultado.output).toContain('el modulo que probaba ya no existe')
  })
})

// ===========================================================================
describe('3. lo que el gate NO bloquea (limitaciones declaradas)', () => {
  it('mover aserciones entre dos ficheros que ya existian pasa: es un refactor', async () => {
    const dir = await repoConBase({
      'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES,
      'packages/db/test/otros.test.ts':
        "import { expect, it } from 'vitest'\nit('otro', () => { expect(1).toBe(1) })\n",
    })
    const resultado = await correrGate(dir, {
      ficheros: {
        'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES.replace(
          '    expect(claim.files).toHaveLength(3)\n',
          '',
        ),
        'packages/db/test/otros.test.ts':
          "import { expect, it } from 'vitest'\nit('otro', () => { expect(1).toBe(1) })\nit('movido', () => { expect(claim.files).toHaveLength(3) })\n",
      },
    })

    expect(resultado.exitCode).toBe(0)
  })

  /**
   * LIMITACION DECLARADA: el skip justificado con un comentario en la propia
   * linea NO bloquea. Lo que cambia respecto de antes es que ahora SE IMPRIME
   * como aviso, de modo que no queda ninguna via de escape invisible en la
   * salida del gate.
   */
  it('un it.skip con comentario en la linea no bloquea, pero sale como AVISO', async () => {
    const dir = await repoConBase({ 'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES })
    const resultado = await correrGate(dir, {
      ficheros: {
        'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES.replace(
          "  it('devuelve el titular', () => {",
          "  it.skip('devuelve el titular', () => { // pendiente del issue #99",
        ),
      },
    })

    expect(resultado.exitCode).toBe(0)
    expect(resultado.output).toContain('AVISO')
    expect(resultado.output).toContain('CON justificacion')
  })

  /**
   * LIMITACION DECLARADA: el emparejamiento del detector de matchers exige que
   * el SUJETO sea identico. Reescribir la asercion entera no se caza, y eso es
   * deliberado — ahi ya no se puede distinguir a maquina un refactor de una
   * trampa. Lo cubre el mutation testing, no este script.
   */
  it('reescribir la asercion entera (otro sujeto) no lo caza este detector', async () => {
    const dir = await repoConBase({ 'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES })
    const resultado = await correrGate(dir, {
      ficheros: {
        'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES.replace(
          "expect(claim.holderId).toEqual('agente-1')",
          'expect(otraCosa.distinta).toBeDefined()',
        ),
      },
    })

    expect(resultado.exitCode).toBe(0)
  })

  it('un PR que no toca nada vigilado sale en verde y lo dice', async () => {
    const dir = await repoConBase({ 'packages/db/test/claims.test.ts': TEST_CON_ASERCIONES })
    const resultado = await correrGate(dir, { ficheros: { 'README.md': '# hola\n' } })

    expect(resultado.exitCode).toBe(0)
    expect(resultado.output).toContain('sin cambios en nada que vigile este gate')
  })
})
