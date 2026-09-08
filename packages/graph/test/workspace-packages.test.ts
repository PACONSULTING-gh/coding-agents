import { randomUUID } from 'node:crypto'

import { runWithTenant } from '@coord/core'
import { closeDatabase, configureDatabase, withTenantConnection } from '@coord/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { blastRadius } from '../src/queries.js'
import { ingestRepository } from '../src/ingest/index.js'

import { startDatabase, type StartedDatabase } from './support/database.js'
import { createTenant } from './support/fixtures.js'
import { createTempRepo, type TempRepo } from './support/git-repo.js'

/**
 * REGRESION del segundo hallazgo del gate del epic 02.
 *
 * El sintoma medido sobre ESTE repo: `blast_radius` de
 * `packages/core/src/tenant.ts` devolvia 2 afectados, los dos dentro de
 * `packages/core`, cuando `packages/db`, `queue`, `webhook` y `worker` dependen
 * de el de verdad. Causa: `import ... from '@coord/core'` resolvia a un nodo
 * `package` sin aristas de salida, asi que el recorrido moria en la frontera de
 * cada paquete — que en un monorepo es donde estan casi todas las dependencias.
 *
 * Los tests de T02 no lo vieron porque sus repos de prueba eran un solo paquete
 * con imports relativos. Este monta un mini-monorepo, que es la forma del repo
 * real (CLAUDE.md 3: la decision de repo es monorepo).
 */

let database: StartedDatabase
let tenantId: string
let repo: TempRepo

beforeAll(async () => {
  database = await startDatabase()
  configureDatabase({ connectionString: database.runtimeUrl, max: 8, allowExitOnIdle: true })
  tenantId = await createTenant('workspace-packages')
  repo = await createTempRepo('workspace')

  // Mini-monorepo: `app` importa `lib` POR NOMBRE, no por ruta relativa.
  await repo.write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n")
  await repo.write('package.json', JSON.stringify({ name: 'root', private: true }))

  await repo.write(
    'packages/lib/package.json',
    JSON.stringify({ name: '@demo/lib', exports: { '.': './dist/index.js' } }),
  )
  await repo.write('packages/lib/src/index.ts', "export { core } from './core.js'\n")
  await repo.write('packages/lib/src/core.ts', 'export function core(): number {\n  return 1\n}\n')

  await repo.write(
    'packages/app/package.json',
    JSON.stringify({ name: '@demo/app', dependencies: { '@demo/lib': 'workspace:*' } }),
  )
  await repo.write(
    'packages/app/src/main.ts',
    "import { core } from '@demo/lib'\n\nexport const value = core()\n",
  )

  await repo.commit('mini monorepo')
}, 240_000)

afterAll(async () => {
  await repo?.cleanup()
  await closeDatabase()
  await database?.container.stop()
})

describe('paquetes locales del workspace', () => {
  it('un import por nombre de paquete cruza a su fichero de entrada', async () => {
    await runWithTenant({ tenantId }, async () => {
      const repoId = randomUUID()
      await ingestRepository({ repoId, repoPath: repo.path })

      const coreId = await withTenantConnection(async (tx) => {
        const r = await tx.query<{ id: string }>(
          `SELECT id FROM graph_nodes
           WHERE tenant_id = $1 AND repo_id = $2 AND kind = 'file' AND path = $3`,
          [tx.tenantId, repoId, 'packages/lib/src/core.ts'],
        )
        return r.rows[0]?.id
      })
      expect(coreId).toBeDefined()

      const result = await blastRadius({ repoId, nodeIds: [coreId!], depth: 5, limit: 100 })
      const paths = (result.hits ?? []).map((hit) => hit.path)

      // La cadena completa: core.ts <- index.ts (entrada de @demo/lib) <- main.ts,
      // que importa '@demo/lib' por nombre. Sin la resolucion de workspace, el
      // recorrido se para en index.ts.
      expect(paths).toContain('packages/lib/src/index.ts')
      expect(paths).toContain('packages/app/src/main.ts')
    })
  }, 240_000)

  it('un paquete externo sigue siendo un nodo package, no se inventa un fichero', async () => {
    await runWithTenant({ tenantId }, async () => {
      const repoId = randomUUID()
      await repo.write(
        'packages/app/src/external.ts',
        "import { readFile } from 'node:fs/promises'\nimport pLimit from 'p-limit'\n\nexport const x = [readFile, pLimit]\n",
      )
      await repo.commit('import externo')
      await ingestRepository({ repoId, repoPath: repo.path })

      const kinds = await withTenantConnection(async (tx) => {
        const r = await tx.query<{ kind: string; path: string }>(
          `SELECT n.kind, n.path FROM graph_nodes n
           WHERE n.tenant_id = $1 AND n.repo_id = $2 AND n.path IN ('p-limit', 'node:fs/promises')`,
          [tx.tenantId, repoId],
        )
        return r.rows
      })
      // `p-limit` no vive en este repo: tiene que seguir siendo un nodo `package`.
      // Si la resolucion de workspace se pasara de lista, aqui aparecerian
      // aristas fantasma hacia ficheros que no existen.
      for (const row of kinds) expect(row.kind).toBe('package')
    })
  }, 240_000)
})
