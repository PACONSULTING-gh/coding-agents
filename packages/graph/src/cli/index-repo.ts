import { access, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { runWithTenant, uuidSchema } from '@coord/core'
import { closeDatabase, configureDatabase, resolveRuntimeConnectionString } from '@coord/db'

import { resolveCheckoutPath } from '../checkout.js'
import { indexRepository } from '../ingest/index-repository.js'

/**
 * Indexar un repositorio a mano.
 *
 * ---------------------------------------------------------------------------
 * POR QUE HACE FALTA
 * ---------------------------------------------------------------------------
 * Hasta ahora el grafo solo se llenaba por el webhook de `push`: para probar el
 * servidor MCP con un agente de verdad habia que registrar la GitHub App, montar
 * un tunel y empujar un commit. La Definition of Done del epic 02 pide
 * exactamente eso —"herramientas MCP conectadas a al menos un agente real"— y
 * estaba bloqueada por la falta de este comando.
 *
 * El `repo_id` se deriva del tenant y del `owner/repo`, igual que en el worker y
 * que en el servidor MCP, asi que lo que escribe este comando es EXACTAMENTE lo
 * que consulta el agente. No hay ids que copiar a mano.
 */

const USAGE = `
Uso:
  graph:index --repo <owner/nombre> [--path <directorio>] [--tenant <uuid>] [--json]

Argumentos:
  --repo <owner/nombre>  Identidad logica del repositorio. De aqui sale el repo_id
                         que usara el servidor MCP. Obligatorio.
  --path <directorio>    Checkout en disco. Por defecto:
                         $GRAPH_CHECKOUT_ROOT/<owner>/<nombre>, y si esa variable
                         no esta, el directorio actual.
  --tenant <uuid>        Tenant. Por defecto $GRAPH_TENANT_ID, y si no,
                         $GRAPH_MCP_TENANT_ID (el mismo que usa el servidor MCP,
                         para que ambos miren el mismo grafo).
  --json                 Salida en JSON, para scripts.

Necesita PGBOUNCER_URL o DATABASE_URL. Ver .env.example.
`.trim()

interface Args {
  repository: string
  repoPath: string
  tenantId: string
  json: boolean
}

class UsageError extends Error {}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`--${name} necesita un valor.`)
  }
  return value
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): Args {
  const repository = readFlag(argv, 'repo')
  if (repository === undefined) {
    throw new UsageError('Falta --repo <owner/nombre>.')
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new UsageError(
      `--repo tiene que ser "owner/nombre". Recibido: ${JSON.stringify(repository)}`,
    )
  }

  const tenantId = readFlag(argv, 'tenant') ?? env['GRAPH_TENANT_ID'] ?? env['GRAPH_MCP_TENANT_ID']
  if (tenantId === undefined || tenantId.trim() === '') {
    throw new UsageError(
      'Falta el tenant. Pasa --tenant <uuid> o define GRAPH_TENANT_ID.\n' +
        'Sin tenant no se puede escribir: la RLS lo exige y este comando no elige uno por ti.',
    )
  }
  if (!uuidSchema.safeParse(tenantId).success) {
    throw new UsageError(`El tenant no es un uuid: ${JSON.stringify(tenantId)}`)
  }

  const explicitPath = readFlag(argv, 'path')
  const checkoutRoot = env['GRAPH_CHECKOUT_ROOT']
  const repoPath =
    explicitPath !== undefined
      ? resolve(explicitPath)
      : checkoutRoot !== undefined && checkoutRoot.trim() !== ''
        ? resolveCheckoutPath(checkoutRoot, repository)
        : process.cwd()

  return { repository, repoPath, tenantId, json: argv.includes('--json') }
}

/** Falla ANTES de tocar la base si el directorio no es un repositorio git. */
async function assertGitRepository(repoPath: string): Promise<void> {
  try {
    const info = await stat(repoPath)
    if (!info.isDirectory()) throw new Error('no es un directorio')
  } catch {
    throw new UsageError(`El directorio no existe o no es accesible: ${repoPath}`)
  }
  try {
    await access(join(repoPath, '.git'))
  } catch {
    throw new UsageError(
      `${repoPath} no es un repositorio git.\n` +
        'La ingesta lista los ficheros con `git ls-files`, asi que sin git no hay nada que indexar.',
    )
  }
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const args = parseArgs(argv, env)
  await assertGitRepository(args.repoPath)

  configureDatabase({
    connectionString: resolveRuntimeConnectionString(env),
    applicationName: 'coord-graph-index',
  })

  try {
    const startedAt = Date.now()
    const result = await runWithTenant({ tenantId: args.tenantId }, () =>
      indexRepository({ repository: args.repository, repoPath: args.repoPath }),
    )
    const elapsedMs = Date.now() - startedAt

    if (args.json) {
      console.log(JSON.stringify({ ...result, elapsedMs }, null, 2))
      return
    }

    const s = result.static
    console.log(`Indexado ${args.repository} desde ${args.repoPath}`)
    console.log(`  repo_id      ${result.repoId}`)
    console.log(`  commit       ${s.commitSha}`)
    console.log(
      `  ficheros     ${String(s.filesParsed)} parseados · ${String(s.filesSkipped)} sin cambios` +
        ` · ${String(s.filesRemoved)} borrados`,
    )
    console.log(
      `  grafo        ${String(s.nodesUpserted)} nodos · ${String(s.edgesInserted)} aristas`,
    )
    // Una lista de build vacia es lo normal: significa que el repo no usa Nx ni
    // Turborepo. Se dice para que nadie lo lea como un fallo silencioso.
    console.log(
      `  build        ${result.build.length === 0 ? 'sin Nx ni Turborepo en este repo' : `${String(result.build.length)} herramienta(s)`}`,
    )
    console.log(`  co-change    ${String(result.cochange.edgesInserted)} aristas`)
    if (s.unresolvedImports > 0) {
      console.log(
        `  sin resolver ${String(s.unresolvedImports)} imports (se descartan: el grafo no inventa aristas)`,
      )
    }
    console.log(`  tiempo       ${String(elapsedMs)} ms`)
    console.log('')
    console.log('Para consultarlo desde un agente, arranca el servidor MCP con')
    console.log(`  GRAPH_MCP_TENANT_ID=${args.tenantId}`)
    console.log(`y pregunta por el repositorio "${args.repository}".`)
  } finally {
    await closeDatabase()
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === `file://${invokedPath}`) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${USAGE}`)
    } else {
      // Nunca en silencio: el error entero, y codigo distinto de cero.
      console.error('La indexacion fallo:', error)
    }
    process.exitCode = 1
  })
}

export { UsageError, USAGE }
