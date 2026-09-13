import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { collectTelemetry, parsePorcelain } from '../src/telemetry.js'

import { createTempRepo, type TempRepo } from '../../../packages/graph/test/support/git-repo.js'

/**
 * Lo que el daemon mira en la maquina (epic 04 / T02).
 *
 * Contra un repo git de VERDAD: lo que se comprueba —que una rama suelta no se
 * confunde con una rama llamada HEAD, que el trabajo sin commitear se ve— es
 * comportamiento de git.
 */

const run = promisify(execFile)
let repo: TempRepo | undefined

afterEach(async () => {
  await repo?.cleanup()
  repo = undefined
})

async function repoBase(): Promise<TempRepo> {
  const r = await createTempRepo('telemetry')
  await r.write('src/a.ts', 'export const a = 1\n')
  await r.commit('base')
  return r
}

describe('la rama', () => {
  it('se recoge cuando hay una', async () => {
    repo = await repoBase()
    expect((await collectTelemetry({ repoPath: repo.path })).branch).toBe('main')
  })

  it('una rama SUELTA no se confunde con una rama llamada HEAD', async () => {
    // `git rev-parse --abbrev-ref HEAD` devuelve literalmente "HEAD" cuando no
    // hay rama. Reportarlo como rama mandaria a alguien a buscar una rama que
    // no existe.
    repo = await repoBase()
    const { stdout } = await run('git', ['-C', repo.path, 'rev-parse', 'HEAD'])
    await run('git', ['-C', repo.path, 'checkout', '-q', stdout.trim()])

    expect((await collectTelemetry({ repoPath: repo.path })).branch).toBeUndefined()
  })

  it('un directorio que no es un repo no revienta el latido', async () => {
    // El latido es precisamente lo que dice que la maquina sigue viva: que se
    // caiga porque la ruta esta mal seria absurdo.
    const telemetria = await collectTelemetry({ repoPath: '/tmp' })
    expect(telemetria.branch).toBeUndefined()
    expect(telemetria.dirtyFileCount).toBe(0)
  })
})

describe('el trabajo sin commitear', () => {
  it('con el arbol limpio, no hay ultimo cambio', async () => {
    // No hay trabajo en curso, y eso se dice devolviendo nada en vez de una
    // fecha cualquiera. La fecha del ultimo commit diria cuando se GUARDO, no
    // cuando se trabajo.
    repo = await repoBase()
    const telemetria = await collectTelemetry({ repoPath: repo.path })

    expect(telemetria.lastFileChangeAt).toBeUndefined()
    expect(telemetria.dirtyFileCount).toBe(0)
  })

  it('un fichero modificado cuenta, y su fecha es la que sale', async () => {
    repo = await repoBase()
    const antes = Date.now()
    await repo.write('src/a.ts', 'export const a = 2\n')

    const telemetria = await collectTelemetry({ repoPath: repo.path })

    expect(telemetria.dirtyFileCount).toBe(1)
    expect(telemetria.lastFileChangeAt?.getTime()).toBeGreaterThanOrEqual(antes - 2_000)
  })

  it('un fichero NUEVO que git no sigue todavia tambien cuenta', async () => {
    // Un agente que acaba de crear el fichero donde va a trabajar esta
    // produciendo. Mirar solo lo que git ya sigue lo daria por parado.
    repo = await repoBase()
    await repo.write('src/nuevo.ts', 'export const nuevo = true\n')

    expect((await collectTelemetry({ repoPath: repo.path })).dirtyFileCount).toBe(1)
  })

  it('se queda con el mas reciente cuando hay varios', async () => {
    repo = await repoBase()
    await repo.write('src/a.ts', 'cambio 1\n')
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    const antesDelSegundo = Date.now()
    await repo.write('src/b.ts', 'cambio 2\n')

    const telemetria = await collectTelemetry({ repoPath: repo.path })

    expect(telemetria.dirtyFileCount).toBe(2)
    expect(telemetria.lastFileChangeAt?.getTime()).toBeGreaterThanOrEqual(antesDelSegundo - 500)
  })

  it('un fichero borrado entre medias no tumba el latido', async () => {
    // El agente borro un fichero justo entre el `git status` y el `stat`. Que
    // el daemon deje de latir por eso seria absurdo.
    repo = await repoBase()
    await repo.remove('src/a.ts')

    const telemetria = await collectTelemetry({ repoPath: repo.path })
    expect(telemetria.dirtyFileCount).toBe(1)
    expect(telemetria.lastFileChangeAt).toBeUndefined()
  })
})

describe('el parseo del estado', () => {
  it('separa por NUL y no por lineas', () => {
    // Un nombre de fichero puede llevar saltos de linea, y partir por `\n`
    // convertiria un fichero raro en dos rutas que no existen.
    expect(parsePorcelain(' M src/a.ts\0?? src/con\nsalto.ts\0')).toEqual([
      'src/a.ts',
      'src/con\nsalto.ts',
    ])
  })

  it('una salida vacia da una lista vacia', () => {
    expect(parsePorcelain('')).toEqual([])
  })

  it('descarta entradas demasiado cortas para tener ruta', () => {
    expect(parsePorcelain(' M \0xx\0')).toEqual([])
  })
})

describe('la tarea', () => {
  it('viaja tal cual cuando se da', async () => {
    repo = await repoBase()
    expect((await collectTelemetry({ repoPath: repo.path, taskRef: 'issue-42' })).taskRef).toBe(
      'issue-42',
    )
  })

  it('y la clave NO viaja vacia cuando no se da', async () => {
    // La forma del objeto es el contrato: `'taskRef' in telemetria` tiene que
    // poder distinguir "no hay tarea" de "hay una clave vacia".
    repo = await repoBase()
    expect(Object.keys(await collectTelemetry({ repoPath: repo.path }))).not.toContain('taskRef')
  })
})
