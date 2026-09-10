import { randomUUID } from 'node:crypto'

import { runWithTenant } from '@coord/core'
import { closeDatabase, configureDatabase, withTenantConnection } from '@coord/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ingestRepository, type IngestionPhase } from '../src/ingest/index.js'
import { EMPTY_STATS } from '../src/ingest/checkpoint.js'
import { createIngestion, saveCheckpoint, upsertFileNodes } from '../src/ingest/store.js'

import { startDatabase, type StartedDatabase } from './support/database.js'
import { createTempRepo, type TempRepo } from './support/git-repo.js'
import { createTenant } from './support/fixtures.js'
import {
  describeEdge,
  readEdges,
  readGraphFiles,
  readIngestions,
  readNodes,
} from './support/graph-state.js'

/**
 * Criterios de aceptacion de T02 (epic 02), contra Postgres de VERDAD y
 * repositorios git de VERDAD:
 *
 *   1. Un solo fichero cambia -> solo ese se reparsea; el resto ni se toca.
 *   2. Un fichero desaparece -> sus nodos, sus aristas y las que APUNTABAN a el
 *      desaparecen tambien.
 *   3. Una ingesta interrumpida a mitad se reanuda sin repetir lo hecho.
 *   4. El grafo que sale es correcto, y —igual de importante— NO contiene
 *      aristas que no deberian existir.
 *
 * El quinto (30 segundos para un repo de tamano medio) esta en
 * `ingest-performance.test.ts`, que necesita generar su propio repositorio.
 *
 * Nada esta mockeado: ni la base, ni git. Un doble de `git ls-files` solo
 * demostraria que el doble hace lo que le hemos dicho (CLAUDE.md 5).
 */

let db: StartedDatabase
const repos: TempRepo[] = []

beforeAll(async () => {
  db = await startDatabase()
  configureDatabase({ connectionString: db.runtimeUrl, max: 8, allowExitOnIdle: true })
}, 300_000)

afterAll(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()))
  await closeDatabase()
  await db?.stop()
})

async function newRepo(prefix: string): Promise<TempRepo> {
  const repo = await createTempRepo(prefix)
  repos.push(repo)
  return repo
}

describe('1. la ingesta es incremental: lo que no cambia, no se vuelve a parsear', () => {
  let tenantId: string
  let repoId: string
  let repo: TempRepo

  beforeAll(async () => {
    tenantId = await createTenant('incremental')
    repoId = randomUUID()
    repo = await newRepo('incremental')
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await repo.write(`src/${name}.ts`, `export function ${name}(): number {\n  return 1\n}\n`)
    }
    // Un fichero que git IGNORA no debe entrar nunca en el grafo.
    await repo.write('.gitignore', 'ignored/\n')
    await repo.write('ignored/secret.ts', 'export const nope = 1\n')
    await repo.commit('inicial')
  })

  it('la primera pasada indexa todos los ficheros seguidos, y solo esos', async () => {
    const result = await runWithTenant({ tenantId }, () =>
      ingestRepository({ repoId, repoPath: repo.path }),
    )

    expect(result.resumed).toBe(false)
    expect(result.totalFiles).toBe(5)
    expect(result.filesPlanned).toBe(5)
    expect(result.filesSkipped).toBe(0)
    // Cada fichero planificado se parsea una vez por fase (simbolos y
    // referencias): son dos fases a proposito, ver `checkpoint.ts`.
    expect(result.filesParsed).toBe(10)

    const indexed = await readGraphFiles(tenantId, repoId)
    expect([...indexed.keys()]).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
      'src/e.ts',
    ])
  })

  it('cambiar UN fichero reparsea ese fichero y ningun otro', async () => {
    const before = await readGraphFiles(tenantId, repoId)

    await repo.write('src/c.ts', 'export function c(): number {\n  return 2\n}\n')
    await repo.commit('cambia c')

    const result = await runWithTenant({ tenantId }, () =>
      ingestRepository({ repoId, repoPath: repo.path }),
    )

    expect(result.filesPlanned).toBe(1)
    expect(result.filesSkipped).toBe(4)
    expect(result.filesParsed).toBe(2)

    // La prueba observable: la fila de los ficheros intactos NO se ha tocado.
    // No es "no se llamo a una funcion" —eso lo diria un espia en memoria—,
    // es que el trabajo no se hizo y quedo constancia en la base.
    const after = await readGraphFiles(tenantId, repoId)
    for (const path of ['src/a.ts', 'src/b.ts', 'src/d.ts', 'src/e.ts']) {
      expect(after.get(path)?.updatedAt).toBe(before.get(path)?.updatedAt)
      expect(after.get(path)?.contentHash).toBe(before.get(path)?.contentHash)
    }
    expect(after.get('src/c.ts')?.updatedAt).not.toBe(before.get('src/c.ts')?.updatedAt)
    expect(after.get('src/c.ts')?.contentHash).not.toBe(before.get('src/c.ts')?.contentHash)
  })

  it('un fichero ignorado por git nunca entra en el grafo', async () => {
    const nodes = await readNodes(tenantId, repoId)
    expect(nodes.map((node) => node.path)).not.toContain('ignored/secret.ts')
  })
})

describe('2. un fichero borrado desaparece del grafo, y las aristas que lo apuntaban tambien', () => {
  let tenantId: string
  let repoId: string
  let repo: TempRepo

  beforeAll(async () => {
    tenantId = await createTenant('borrado')
    repoId = randomUUID()
    repo = await newRepo('borrado')
    await repo.write('src/lib.ts', 'export function libFn(): number {\n  return 1\n}\n')
    await repo.write(
      'src/app.ts',
      "import { libFn } from './lib.js'\n\nexport function run(): number {\n  return libFn()\n}\n",
    )
    await repo.commit('inicial')
    await runWithTenant({ tenantId }, () => ingestRepository({ repoId, repoPath: repo.path }))
  })

  it('antes de borrar, las aristas hacia el fichero existen', async () => {
    const edges = (await readEdges(tenantId, repoId)).map(describeEdge)
    expect(edges).toContain('file:src/app.ts --imports--> file:src/lib.ts')
    expect(edges).toContain('symbol:src/app.ts#run --calls--> symbol:src/lib.ts#libFn')
  })

  it('al borrarlo no queda ni el nodo ni ninguna arista que lo mencione', async () => {
    await repo.remove('src/lib.ts')
    await repo.commit('borra lib')

    const result = await runWithTenant({ tenantId }, () =>
      ingestRepository({ repoId, repoPath: repo.path }),
    )

    // Las aristas de `src/app.ts` hacia el fichero borrado desaparecen por la
    // clave ajena ON DELETE CASCADE, haya o no reparseo.
    expect(result.filesRemoved).toBe(1)
    // Y `src/app.ts` SI se replanifica, aunque su contenido no haya cambiado:
    // su `import './lib.js'` ha pasado de resolver a un fichero a no resolver a
    // nada. Es el mismo mecanismo que hace que las aristas VUELVAN si el
    // borrado se revierte (ver el test siguiente y la migracion 0009). La
    // incrementalidad no se resiente: replanificar por cambio del conjunto de
    // rutas solo alcanza a los ficheros cuyos imports cambian de destino, y el
    // criterio 1 —cambiar el CONTENIDO de un fichero no toca a los demas—
    // sigue comprobandose en el describe 1.
    expect(result.filesPlanned).toBe(1)
    expect(result.filesSkipped).toBe(0)
    // El import huerfano se cuenta en vez de callarse.
    expect(result.unresolvedImports).toBe(1)

    const nodes = await readNodes(tenantId, repoId)
    expect(nodes.filter((node) => node.path === 'src/lib.ts')).toEqual([])

    const edges = await readEdges(tenantId, repoId)
    const touching = edges.filter(
      (edge) => edge.from.path === 'src/lib.ts' || edge.to.path === 'src/lib.ts',
    )
    expect(touching.map(describeEdge)).toEqual([])

    // Y el resto del grafo sigue en pie.
    expect(edges.map(describeEdge)).toContain('file:src/app.ts --contains--> symbol:src/app.ts#run')

    const indexed = await readGraphFiles(tenantId, repoId)
    expect([...indexed.keys()]).toEqual(['src/app.ts'])
  })

  /**
   * REVERTIR UN BORRADO. El contenido del repo vuelve a ser byte a byte el
   * inicial, en el que esas aristas SI existian, asi que el grafo tiene que
   * volver a tenerlas: el criterio es "el grafo refleja el estado del repo", no
   * "el grafo refleja los ficheros que han cambiado de hash".
   *
   * Antes esto fallaba en silencio: `src/app.ts` no cambia de hash, no se
   * reparsea, y las aristas hacia `src/lib.ts` no volvian NUNCA — con
   * `unresolvedImports: 0` en el resultado, asi que ni siquiera quedaba senal de
   * que faltara algo. Lo que lo arregla es replanificar los ficheros cuyos
   * especificadores de import cambian de destino al cambiar el conjunto de rutas
   * del repo (migracion 0009).
   */
  it('al volver a anadir el fichero identico, las aristas vuelven', async () => {
    await repo.write('src/lib.ts', 'export function libFn(): number {\n  return 1\n}\n')
    await repo.commit('revierte el borrado de lib')

    const result = await runWithTenant({ tenantId }, () =>
      ingestRepository({ repoId, repoPath: repo.path }),
    )

    // `src/lib.ts` se replanifica por ser nuevo, y `src/app.ts` TAMBIEN aunque
    // su hash no haya cambiado: su import volvio a resolver a un fichero.
    expect(result.filesPlanned).toBe(2)
    expect(result.unresolvedImports).toBe(0)

    const edges = (await readEdges(tenantId, repoId)).map(describeEdge)
    expect(edges).toContain('file:src/app.ts --imports--> file:src/lib.ts')
    expect(edges).toContain('symbol:src/app.ts#run --calls--> symbol:src/lib.ts#libFn')
  })
})

describe('2 bis. un fichero NUEVO que satisface un import pendiente crea su arista', () => {
  let tenantId: string
  let repoId: string
  let repo: TempRepo

  beforeAll(async () => {
    tenantId = await createTenant('alta-que-resuelve')
    repoId = randomUUID()
    repo = await newRepo('alta-que-resuelve')
    // `src/nuevo.ts` NO existe todavia: el import no resuelve a nada.
    await repo.write(
      'src/app.ts',
      "import { nuevoFn } from './nuevo.js'\n\nexport function run(): number {\n  return nuevoFn()\n}\n",
    )
    await repo.commit('inicial, con un import que no apunta a nada')
  })

  it('de entrada el import NO produce arista, y se cuenta', async () => {
    const result = await runWithTenant({ tenantId }, () =>
      ingestRepository({ repoId, repoPath: repo.path }),
    )
    expect(result.unresolvedImports).toBe(1)
    const edges = (await readEdges(tenantId, repoId)).map(describeEdge)
    expect(edges.some((edge) => edge.includes('src/nuevo.ts'))).toBe(false)
  })

  it('al anadir el fichero, `src/app.ts` se replanifica aunque no haya cambiado', async () => {
    await repo.write('src/nuevo.ts', 'export function nuevoFn(): number {\n  return 7\n}\n')
    await repo.commit('anade nuevo.ts')

    const antes = await readGraphFiles(tenantId, repoId)
    const hashAntes = antes.get('src/app.ts')?.contentHash

    const result = await runWithTenant({ tenantId }, () =>
      ingestRepository({ repoId, repoPath: repo.path }),
    )

    // El hash de app.ts NO ha cambiado: la replanificacion viene de que su
    // especificador `./nuevo.js` paso de no resolver a resolver a un fichero.
    const despues = await readGraphFiles(tenantId, repoId)
    expect(despues.get('src/app.ts')?.contentHash).toBe(hashAntes)
    expect(result.filesPlanned).toBe(2)
    expect(result.unresolvedImports).toBe(0)

    const edges = (await readEdges(tenantId, repoId)).map(describeEdge)
    expect(edges).toContain('file:src/app.ts --imports--> file:src/nuevo.ts')
    expect(edges).toContain('symbol:src/app.ts#run --calls--> symbol:src/nuevo.ts#nuevoFn')
  })
})

describe('2 ter. la ingesta no sella un commit que no ha visto', () => {
  it('si el checkout no esta en el commit pedido, falla ruidoso en vez de mentir', async () => {
    const tenantId = await createTenant('commit-desalineado')
    const repoId = randomUUID()
    const repo = await newRepo('commit-desalineado')
    await repo.write('src/a.ts', 'export const a = 1\n')
    const head = await repo.commit('inicial')

    // `commitSha` es lo que el worker pasa desde el `after` de un push. Si el
    // checkout esta en otro commit, indexar el arbol de trabajo y sellarlo con
    // esa etiqueta deja el grafo desincronizado EN SILENCIO: la siguiente
    // ingesta de ese commit daria los ficheros por "sin cambios".
    await expect(
      runWithTenant({ tenantId }, () =>
        ingestRepository({ repoId, repoPath: repo.path, commitSha: 'b'.repeat(40) }),
      ),
    ).rejects.toThrow(/se pidio indexar/)

    // Y no ha quedado ninguna ingesta a medias ni nada escrito.
    expect(await readIngestions(tenantId, repoId)).toEqual([])
    expect(await readNodes(tenantId, repoId)).toEqual([])

    // El HEAD real si se acepta, y con el sha corto tambien.
    const ok = await runWithTenant({ tenantId }, () =>
      ingestRepository({ repoId, repoPath: repo.path, commitSha: head.slice(0, 10) }),
    )
    expect(ok.filesPlanned).toBe(1)
  })
})

describe('3. una ingesta interrumpida a mitad se reanuda donde iba', () => {
  const TOTAL = 12
  let tenantId: string
  let repoId: string
  let repo: TempRepo
  let expectedFiles: string[]

  beforeAll(async () => {
    tenantId = await createTenant('reanudable')
    repoId = randomUUID()
    repo = await newRepo('reanudable')
    expectedFiles = []
    for (let index = 0; index < TOTAL; index += 1) {
      const name = `f${String(index).padStart(2, '0')}`
      const previous = `f${String(index - 1).padStart(2, '0')}`
      const header = index === 0 ? '' : `import { ${previous} } from './${previous}.js'\n`
      const body = index === 0 ? '  return 1' : `  return ${previous}() + 1`
      await repo.write(
        'src/' + name + '.ts',
        `${header}\nexport function ${name}(): number {\n${body}\n}\n`,
      )
      expectedFiles.push(`src/${name}.ts`)
    }
    await repo.commit('inicial')
  })

  it('se interrumpe DENTRO de un lote y no se confirma nada de ese lote', async () => {
    let parsed = 0
    await expect(
      runWithTenant({ tenantId }, () =>
        ingestRepository({
          repoId,
          repoPath: repo.path,
          batchSize: 4,
          // En serie: asi la interrupcion cae en un punto conocido del lote.
          concurrency: 1,
          hooks: {
            onFileParsed: () => {
              parsed += 1
              // Sexto fichero: lote 1 (0-3) ya confirmado, lote 2 a medias.
              if (parsed === 6) throw new Error('SIGKILL simulado a mitad de lote')
            },
          },
        }),
      ),
    ).rejects.toThrow('SIGKILL simulado')

    const ingestions = await readIngestions(tenantId, repoId)
    expect(ingestions).toHaveLength(1)
    const ingestion = ingestions[0]
    expect(ingestion?.status).toBe('failed')
    // El motivo queda escrito: un `failed` mudo obliga a reproducirlo todo.
    expect(ingestion?.error).toContain('SIGKILL simulado')

    const checkpoint = ingestion?.checkpoint as { phase: string; nextIndex: number }
    expect(checkpoint.phase).toBe('symbols')
    expect(checkpoint.nextIndex).toBe(4)

    // Solo lo del lote confirmado esta en la base. Los dos ficheros parseados
    // del lote 2 murieron con su transaccion.
    const indexed = await readGraphFiles(tenantId, repoId)
    expect([...indexed.keys()]).toEqual(expectedFiles.slice(0, 4))
  })

  it('al reanudar continua desde el checkpoint y NO repite lo ya hecho', async () => {
    const parsedByPhase = new Map<IngestionPhase, string[]>()

    const result = await runWithTenant({ tenantId }, () =>
      ingestRepository({
        repoId,
        repoPath: repo.path,
        batchSize: 4,
        concurrency: 1,
        hooks: {
          onFileParsed: ({ path, phase }) => {
            const list = parsedByPhase.get(phase) ?? []
            list.push(path)
            parsedByPhase.set(phase, list)
          },
        },
      }),
    )

    expect(result.resumed).toBe(true)

    // Los cuatro primeros NO se vuelven a parsear en la fase de simbolos.
    expect(parsedByPhase.get('symbols')).toEqual(expectedFiles.slice(4))
    // La fase de referencias no habia empezado: ahi si van los doce.
    expect(parsedByPhase.get('references')).toEqual(expectedFiles)

    // Contadores persistidos: 12 ficheros x 2 fases = 24 parseos contabilizados,
    // ni uno mas. Los dos parseos tirados del lote abortado no se cuentan
    // porque su lote nunca se confirmo.
    expect(result.filesParsed).toBe(TOTAL * 2)

    const ingestions = await readIngestions(tenantId, repoId)
    expect(ingestions.map((row) => row.status)).toEqual(['completed'])

    const indexed = await readGraphFiles(tenantId, repoId)
    expect([...indexed.keys()]).toEqual(expectedFiles)
  })

  it('el grafo reanudado es identico al de una indexacion limpia', async () => {
    // Control: el MISMO repositorio indexado de cero en otro `repo_id`. Si la
    // reanudacion se hubiera saltado trabajo, aqui se veria la diferencia.
    const controlRepoId = randomUUID()
    await runWithTenant({ tenantId }, () =>
      ingestRepository({ repoId: controlRepoId, repoPath: repo.path }),
    )

    const resumed = (await readEdges(tenantId, repoId)).map(describeEdge).sort()
    const clean = (await readEdges(tenantId, controlRepoId)).map(describeEdge).sort()

    expect(resumed).toEqual(clean)
    expect(resumed.length).toBeGreaterThan(0)
  })
})

/**
 * LA ATOMICIDAD LOTE + CHECKPOINT, EJERCITADA.
 *
 * El README del paquete vende esta propiedad con fuerza: "los datos del lote y
 * el checkpoint se confirman en la MISMA transaccion, o los dos o ninguno". Los
 * tests de reanudacion de arriba interrumpen SIEMPRE durante el parseo, o sea
 * ANTES de que el lote abra su transaccion, asi que la propiedad se leia en el
 * codigo pero no la ejercitaba nadie.
 *
 * Esto la ejercita: se escriben datos Y se guarda el checkpoint por las MISMAS
 * funciones que usa la ingesta, dentro de una sola transaccion que despues
 * falla. Si los dos no compartieran transaccion, el checkpoint diria que se hizo
 * un trabajo que no esta.
 */
describe('3 bis. lote y checkpoint viajan en la MISMA transaccion', () => {
  it('si la transaccion del lote falla, ni los datos ni el checkpoint quedan', async () => {
    const tenantId = await createTenant('atomicidad')
    const repoId = randomUUID()

    const ingestionId = await runWithTenant({ tenantId }, () =>
      withTenantConnection((tx) => createIngestion(tx, repoId, 'a'.repeat(40))),
    )

    const checkpoint = {
      version: 1 as const,
      phase: 'symbols' as const,
      files: ['src/a.ts'],
      removed: [],
      nextIndex: 1,
      stats: { ...EMPTY_STATS, filesPlanned: 1 },
    }

    await expect(
      runWithTenant({ tenantId }, () =>
        withTenantConnection(async (tx) => {
          await upsertFileNodes(tx, repoId, [{ path: 'src/a.ts', language: 'typescript' }])
          await saveCheckpoint(tx, ingestionId, checkpoint)
          // Todo lo anterior YA esta escrito en esta transaccion. Aqui muere.
          throw new Error('caida despues de escribir el lote y el checkpoint')
        }),
      ),
    ).rejects.toThrow('caida despues de escribir')

    // Ni el nodo del lote...
    expect(await readNodes(tenantId, repoId)).toEqual([])
    // ...ni el avance del checkpoint: sigue en el `{}` por defecto de la
    // columna, o sea "no llego a planificar nada".
    const ingestions = await readIngestions(tenantId, repoId)
    expect(ingestions).toHaveLength(1)
    expect(ingestions[0]?.checkpoint).toEqual({})
    expect(ingestions[0]?.status).toBe('running')
  })

  it('control: sin el fallo, los mismos dos escritos SI quedan', async () => {
    // Sin este control, el test de arriba pasaria igual si `upsertFileNodes` o
    // `saveCheckpoint` no escribieran nada nunca.
    const tenantId = await createTenant('atomicidad-control')
    const repoId = randomUUID()

    const ingestionId = await runWithTenant({ tenantId }, () =>
      withTenantConnection((tx) => createIngestion(tx, repoId, 'c'.repeat(40))),
    )
    await runWithTenant({ tenantId }, () =>
      withTenantConnection(async (tx) => {
        await upsertFileNodes(tx, repoId, [{ path: 'src/a.ts', language: 'typescript' }])
        await saveCheckpoint(tx, ingestionId, {
          version: 1,
          phase: 'symbols',
          files: ['src/a.ts'],
          removed: [],
          nextIndex: 1,
          stats: { ...EMPTY_STATS, filesPlanned: 1 },
        })
      }),
    )

    expect((await readNodes(tenantId, repoId)).map((n) => n.path)).toEqual(['src/a.ts'])
    const ingestions = await readIngestions(tenantId, repoId)
    expect((ingestions[0]?.checkpoint as { nextIndex: number }).nextIndex).toBe(1)
  })
})

describe('4. el grafo dice la verdad: las aristas que hay, y las que NO', () => {
  let tenantId: string
  let repoId: string
  let repo: TempRepo
  let edges: string[]
  let unresolvedImports: number

  beforeAll(async () => {
    tenantId = await createTenant('correccion')
    repoId = randomUUID()
    repo = await newRepo('correccion')

    await repo.write('src/base.ts', 'export class Base {\n  setup(): void {}\n}\n')
    await repo.write('src/util.ts', 'export function helper(): number {\n  return 1\n}\n')
    // SENUELO: un fichero del repo que se llama igual que un paquete externo.
    // Un resolutor ingenuo (buscar un fichero cuyo nombre case) crearia aqui
    // una arista falsa. `zod` es un especificador NUDO: no es una ruta.
    await repo.write('src/zod.ts', 'export const decoy = 1\n')
    await repo.write(
      'src/widget.ts',
      [
        "import { Base } from './base.js'",
        "import { helper } from './util.js'",
        "import { z } from 'zod'",
        // Import que NO apunta a ningun fichero del repo: no debe producir nada.
        "import { ghost } from './no-existe.js'",
        '',
        'export class Widget extends Base {',
        '  render(): number {',
        '    z.string()',
        '    return helper() + Number(ghost)',
        '  }',
        '}',
        '',
      ].join('\n'),
    )

    await repo.write('py/core.py', 'class Core:\n    def setup(self):\n        pass\n')
    // SENUELO en Python: `py/os.py` NO es el modulo `os`, que se resuelve desde
    // la raiz del repositorio.
    await repo.write('py/os.py', 'DECOY = 1\n')
    await repo.write(
      'py/app.py',
      [
        'import os',
        'from .core import Core',
        '',
        '',
        'class App(Core):',
        '    def run(self):',
        '        return boot()',
        '',
        '',
        'def boot():',
        '    return os.getpid()',
        '',
      ].join('\n'),
    )
    await repo.commit('inicial')

    const result = await runWithTenant({ tenantId }, () =>
      ingestRepository({ repoId, repoPath: repo.path }),
    )
    unresolvedImports = result.unresolvedImports
    edges = (await readEdges(tenantId, repoId)).map(describeEdge)
  })

  it('extrae imports, contains, calls e inherits de TypeScript', () => {
    expect(edges).toContain('file:src/widget.ts --imports--> file:src/base.ts')
    expect(edges).toContain('file:src/widget.ts --imports--> file:src/util.ts')
    expect(edges).toContain('file:src/widget.ts --contains--> symbol:src/widget.ts#Widget')
    expect(edges).toContain('symbol:src/widget.ts#Widget --inherits--> symbol:src/base.ts#Base')
    expect(edges).toContain('symbol:src/widget.ts#Widget --calls--> symbol:src/util.ts#helper')
  })

  it('extrae lo mismo de Python', () => {
    expect(edges).toContain('file:py/app.py --imports--> file:py/core.py')
    expect(edges).toContain('file:py/app.py --contains--> symbol:py/app.py#App')
    expect(edges).toContain('symbol:py/app.py#App --inherits--> symbol:py/core.py#Core')
    expect(edges).toContain('symbol:py/app.py#App --calls--> symbol:py/app.py#boot')
  })

  it('un paquete externo es un nodo `package`, nunca un fichero del repo', async () => {
    expect(edges).toContain('file:src/widget.ts --imports--> package:zod')
    expect(edges).toContain('file:py/app.py --imports--> package:os')

    // La arista fantasma que un resolutor ingenuo si crearia:
    expect(edges).not.toContain('file:src/widget.ts --imports--> file:src/zod.ts')
    expect(edges).not.toContain('file:py/app.py --imports--> file:py/os.py')

    // Y `zod` / `os` no existen como nodos de fichero inventados.
    const nodes = await readNodes(tenantId, repoId)
    expect(nodes.filter((node) => node.kind === 'file' && node.path === 'zod')).toEqual([])
    expect(nodes.filter((node) => node.kind === 'file' && node.path === 'os')).toEqual([])
  })

  it('un import que no apunta a nada no produce arista: se descarta y se cuenta', () => {
    expect(unresolvedImports).toBeGreaterThanOrEqual(1)
    const dangling = edges.filter((edge) => edge.includes('no-existe'))
    expect(dangling).toEqual([])
  })

  it('una llamada a traves de un paquete externo no inventa un simbolo', () => {
    // `z.string()`: `z` viene de `zod`, que no es un fichero del repo. No hay
    // simbolo destino que exista, asi que no hay arista.
    const invented = edges.filter((edge) => edge.includes('#string'))
    expect(invented).toEqual([])
  })

  it('todas las aristas de esta tarea son de origen `static` y peso 1', async () => {
    const rows = await readEdges(tenantId, repoId)
    expect(rows.every((edge) => edge.source === 'static')).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
  })

  it('el grafo de un tenant no es visible desde otro', async () => {
    const otherTenant = await createTenant('correccion-vecino')
    const nodes = await readNodes(otherTenant, repoId)
    expect(nodes).toEqual([])
  })
})
