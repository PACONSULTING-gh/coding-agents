import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ValidationError } from '@coord/core'
import { afterEach, describe, expect, it } from 'vitest'

import { readDelivery } from '../src/delivery.js'

import { createTempRepo, type TempRepo } from '../../../packages/graph/test/support/git-repo.js'

/**
 * Leer una entrega de un repo git de VERDAD (uno temporal, no un doble): lo que
 * se comprueba —que `merge-base` recorta el trabajo ajeno, que una ref con
 * pinta de opcion no llega al proceso, que un fallo de tests es un dato y no un
 * error— es comportamiento de git y del proceso hijo. Un doble solo demostraria
 * que el doble hace lo que le hemos dicho (CLAUDE.md 5).
 */

const TEST_OK = ['node', '-e', 'console.log("3 passed")']
const TEST_FALLA = ['node', '-e', 'console.log("1 failed"); process.exit(1)']

let repo: TempRepo | undefined

afterEach(async () => {
  await repo?.cleanup()
  repo = undefined
})

/** Un repo con `main` y una rama `entrega` que cambia un fichero. */
async function repoConEntrega(): Promise<TempRepo> {
  const r = await createTempRepo('delivery')
  await r.write('src/a.ts', 'export const a = 1\n')
  await r.commit('base')
  await run(r, ['checkout', '-q', '-b', 'entrega'])
  await r.write('src/a.ts', 'export const a = 2\n')
  await r.commit('la entrega')
  return r
}

async function run(r: TempRepo, args: readonly string[]): Promise<void> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  await promisify(execFile)('git', ['-C', r.path, ...args])
}

describe('que se entrega, exactamente', () => {
  it('el diff lleva el cambio, y los shas de los dos extremos', async () => {
    repo = await repoConEntrega()

    const entrega = await readDelivery({
      repoPath: repo.path,
      baseRef: 'main',
      headRef: 'entrega',
      testCommand: TEST_OK,
    })

    expect(entrega.diff).toContain('-export const a = 1')
    expect(entrega.diff).toContain('+export const a = 2')
    expect(entrega.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect(entrega.baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(entrega.baseSha).not.toBe(entrega.headSha)
  })

  it('el trabajo que OTROS mergearon mientras tanto NO entra en el diff', async () => {
    // Es la razon de usar `merge-base` y no la punta de la base. Con `main..head`
    // el Verifier juzgaria codigo que este agente no escribio, y un FAIL sobre
    // codigo ajeno manda al agente a arreglar algo que no es suyo Y le gasta un
    // intento.
    repo = await repoConEntrega()
    await run(repo, ['checkout', '-q', 'main'])
    await repo.write('src/de-otro.ts', 'export const ajeno = true\n')
    await repo.commit('trabajo de otra persona')
    await run(repo, ['checkout', '-q', 'entrega'])

    const entrega = await readDelivery({
      repoPath: repo.path,
      baseRef: 'main',
      headRef: 'entrega',
      testCommand: TEST_OK,
    })

    expect(entrega.diff).toContain('src/a.ts')
    expect(entrega.diff).not.toContain('de-otro.ts')
    expect(entrega.diff).not.toContain('ajeno')
  })
})

describe('la salida de los tests es un DATO, no un error', () => {
  it('con los tests en verde', async () => {
    repo = await repoConEntrega()
    const entrega = await readDelivery({
      repoPath: repo.path,
      baseRef: 'main',
      headRef: 'entrega',
      testCommand: TEST_OK,
    })

    expect(entrega.testRun.exitCode).toBe(0)
    expect(entrega.testRun.output).toContain('3 passed')
    expect(entrega.testRun.command).toBe(TEST_OK.join(' '))
  })

  it('con los tests en ROJO devuelve la salida, no lanza', async () => {
    // El Verifier necesita ver los tests rojos para poder decir FAIL. Lanzar
    // aqui convertiria "los tests fallan" en "no se pudo verificar", que son
    // cosas distintas y con destinos distintos en el flujo de T06.
    repo = await repoConEntrega()
    const entrega = await readDelivery({
      repoPath: repo.path,
      baseRef: 'main',
      headRef: 'entrega',
      testCommand: TEST_FALLA,
    })

    expect(entrega.testRun.exitCode).toBe(1)
    expect(entrega.testRun.output).toContain('1 failed')
  })

  it('un comando que NO EXISTE si lanza', async () => {
    // Sin salida ninguna no es "la suite esta roja", es que el comando no llego
    // a correr. Devolver exitCode 1 con salida vacia se leeria como una suite
    // en rojo y mandaria al agente a arreglar un fallo que no existe.
    repo = await repoConEntrega()
    await expect(
      readDelivery({
        repoPath: repo.path,
        baseRef: 'main',
        headRef: 'entrega',
        testCommand: ['este-comando-no-existe-en-ninguna-parte'],
      }),
    ).rejects.toThrow()
  })

  it('una suite que habla MUCHO no revienta el buffer', async () => {
    // El defecto de `execFile` es 1 MiB, y una suite de verdad se lo come sin
    // esfuerzo. Sin subir `maxBuffer` esto no devuelve una salida recortada:
    // LANZA, y una entrega perfectamente verificable se leeria como "no se pudo
    // verificar" — que en el flujo de T06 escala a un humano sin motivo.
    repo = await repoConEntrega()
    const entrega = await readDelivery({
      repoPath: repo.path,
      baseRef: 'main',
      headRef: 'entrega',
      testCommand: [
        'node',
        '-e',
        'process.stdout.write("x".repeat(2 * 1024 * 1024)); console.log("\\nlisto")',
      ],
    })

    expect(entrega.testRun.output.length).toBeGreaterThan(2 * 1024 * 1024)
    expect(entrega.testRun.output).toContain('listo')
  })

  it('los tests corren DENTRO del repo', async () => {
    // Si corrieran en el cwd del proceso, la suite que se ejecutaria seria la
    // de esta plataforma y no la de la entrega. El informe hablaria de otro
    // codigo.
    repo = await repoConEntrega()
    await writeFile(join(repo.path, 'marca.txt'), 'estoy en el repo\n', 'utf8')

    const entrega = await readDelivery({
      repoPath: repo.path,
      baseRef: 'main',
      headRef: 'entrega',
      testCommand: ['node', '-e', 'console.log(require("fs").readFileSync("marca.txt","utf8"))'],
    })

    expect(entrega.testRun.output).toContain('estoy en el repo')
  })
})

describe('una entrega vacia no es una entrega', () => {
  it('sin cambios, lanza', async () => {
    // Verificarla daria un informe de conformidad sobre la nada, y ese informe
    // se puede usar para aprobar un merge.
    repo = await createTempRepo('delivery-vacia')
    await repo.write('a.txt', 'igual\n')
    await repo.commit('unico')

    await expect(
      readDelivery({
        repoPath: repo.path,
        baseRef: 'main',
        headRef: 'main',
        testCommand: TEST_OK,
      }),
    ).rejects.toThrow(ValidationError)
  })
})

describe('un diff que no cabe NO se trunca', () => {
  it('se lanza en vez de verificar media entrega', async () => {
    // Truncar en silencio haria que el Verifier juzgara la mitad y dijera APTO,
    // y el humano leeria "apto" sin saber que la otra mitad no la miro nadie.
    repo = await repoConEntrega()

    await expect(
      readDelivery({
        repoPath: repo.path,
        baseRef: 'main',
        headRef: 'entrega',
        testCommand: TEST_OK,
        maxDiffBytes: 10,
      }),
    ).rejects.toThrow(/no se trunca/i)
  })

  it('un diff ENORME da el error claro, no un fallo de buffer', async () => {
    // El defecto de `execFile` es 1 MiB. Sin subir `maxBuffer` en la llamada a
    // git, un diff grande no da "no cabe en el prompt": da un error del proceso
    // hijo, sin fichero ni linea, que no le dice nada a quien lo lee. El
    // mensaje que ve una persona es parte del comportamiento.
    repo = await repoConEntrega()
    await repo.write('gordo.txt', `${'linea de relleno\n'.repeat(120_000)}`)
    await repo.commit('un fichero muy gordo')

    await expect(
      readDelivery({
        repoPath: repo.path,
        baseRef: 'main',
        headRef: 'entrega',
        testCommand: TEST_OK,
      }),
    ).rejects.toThrow(/no se trunca/i)
  })

  it('un diff EXACTAMENTE del tamaño del tope pasa', async () => {
    // El borde importa: con `>=` en vez de `>`, una entrega que mide justo lo
    // permitido se rechazaria, y el limite documentado seria mentira por un
    // byte.
    repo = await repoConEntrega()
    const holgado = await readDelivery({
      repoPath: repo.path,
      baseRef: 'main',
      headRef: 'entrega',
      testCommand: TEST_OK,
      maxDiffBytes: 1_000_000,
    })
    const exacto = Buffer.byteLength(holgado.diff, 'utf8')

    const alBorde = await readDelivery({
      repoPath: repo.path,
      baseRef: 'main',
      headRef: 'entrega',
      testCommand: TEST_OK,
      maxDiffBytes: exacto,
    })
    expect(alBorde.diff).toBe(holgado.diff)
  })

  it('un tope de 1 es configuracion valida, por absurda que sea', () => {
    // El limite es `>= 1`, no `> 1`. Un tope de un byte es una politica
    // ridicula, pero es una politica, no una entrada invalida: tiene que fallar
    // por TAMAÑO y no por configuracion.
    return expect(
      (async () => {
        repo = await repoConEntrega()
        return readDelivery({
          repoPath: repo.path,
          baseRef: 'main',
          headRef: 'entrega',
          testCommand: TEST_OK,
          maxDiffBytes: 1,
        })
      })(),
    ).rejects.toThrow(/no se trunca/i)
  })
})

describe('la frontera de entrada', () => {
  it.each([
    ['baseRef con pinta de opcion', { baseRef: '--output=/tmp/robado' }],
    ['headRef con pinta de opcion', { headRef: '-x' }],
  ])('%s se rechaza antes de llegar al proceso', async (_caso, extra) => {
    // Un nombre de rama que empieza por `-` lo lee git como una OPCION.
    // `--output=/etc/passwd` es un nombre de rama sintacticamente valido.
    repo = await repoConEntrega()
    await expect(
      readDelivery({
        repoPath: repo.path,
        baseRef: 'main',
        headRef: 'entrega',
        testCommand: TEST_OK,
        ...extra,
      }),
    ).rejects.toThrow(ValidationError)
  })

  it.each([
    ['baseRef', { baseRef: '  ' }],
    ['headRef', { headRef: '' }],
  ])('un %s vacio se rechaza', async (_caso, extra) => {
    repo = await repoConEntrega()
    await expect(
      readDelivery({
        repoPath: repo.path,
        baseRef: 'main',
        headRef: 'entrega',
        testCommand: TEST_OK,
        ...extra,
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('sin comando de tests se rechaza, y el motivo lo explica', async () => {
    // Sin salida de tests, un criterio que se demuestra corriendolos quedaria en
    // SIN_EVIDENCIA por falta del DATO y no por falta del trabajo — y el flujo
    // de T06 mandaria la tarea a la fase de criterios por un fallo nuestro.
    repo = await repoConEntrega()
    await expect(
      readDelivery({
        repoPath: repo.path,
        baseRef: 'main',
        headRef: 'entrega',
        testCommand: [],
      }),
    ).rejects.toThrow(/SIN_EVIDENCIA/)
  })

  it.each([0, -1, 2.5])(
    'un tope de diff de %s se rechaza COMO CONFIGURACION',
    async (maxDiffBytes) => {
      // Se comprueba el MENSAJE y no solo el tipo: con un tope de 0, un diff de
      // 200 bytes tambien lanza por tamaño, asi que `toThrow(ValidationError)` a
      // secas pasaba igual aunque se borrase esta validacion entera. Lo delato el
      // mutation testing.
      repo = await repoConEntrega()
      await expect(
        readDelivery({
          repoPath: repo.path,
          baseRef: 'main',
          headRef: 'entrega',
          testCommand: TEST_OK,
          maxDiffBytes,
        }),
      ).rejects.toThrow(/entero >= 1/)
    },
  )
})
