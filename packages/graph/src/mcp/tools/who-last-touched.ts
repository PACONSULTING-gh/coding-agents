import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'

import { withTenantConnection } from '@coord/db'
import pLimit from 'p-limit'
import { z } from 'zod'

import { repositorySchema, resolveCheckoutPath } from '../../checkout.js'
import { truncateToBudget, type Budgeted } from '../budget.js'
import type { GraphMcpServerConfig } from '../context.js'
import { relativeFilePathSchema } from '../paths.js'
import { resolveRepoId } from '../resolve.js'

/**
 * `who_last_touched` (T05): "quien toco esto por ultimo" tiene que devolver
 * PERSONAS, no hashes de commit -- es el criterio de aceptacion literal.
 *
 * ---------------------------------------------------------------------------
 * DE DONDE SALE EL CHECKOUT
 * ---------------------------------------------------------------------------
 * De `GRAPH_CHECKOUT_ROOT` (ver `context.ts` y `apps/worker/src/graph-ingestion.ts`,
 * que la usa para lo mismo en la ingesta): la MISMA convencion
 * `<raiz>/<owner>/<repo>` y la MISMA proteccion contra path traversal
 * (`resolveCheckoutPath`, compartida via `checkout.ts`). Sin la variable, esta
 * herramienta falla al LLAMARLA (no al arrancar el servidor: las otras cuatro
 * herramientas no la necesitan y arrancar igual es lo correcto).
 *
 * ---------------------------------------------------------------------------
 * git log, no la ingesta del grafo
 * ---------------------------------------------------------------------------
 * El grafo (T01-T03) no guarda "quien" toco un fichero, solo la ESTRUCTURA del
 * codigo. `git log` sobre el checkout SI lo sabe, y es la misma via que ya usa
 * `cochange/git.ts`: `execFile` con argumentos en array (nunca `exec` con una
 * cadena) y `-C <ruta>`.
 *
 * ---------------------------------------------------------------------------
 * PERSONA, NO CORREO
 * ---------------------------------------------------------------------------
 * El correo del autor de git se cruza contra `users` (mismo tenant, por
 * `email`) para dar el nombre visible del sistema; si NO hay usuario que
 * corresponda, se devuelve el nombre de autor de git tal cual -- nunca un
 * hash, nunca "desconocido". El correo NUNCA sale en la respuesta, haya o no
 * match: es un dato personal y esto va a un LLM, y el nombre ya contesta la
 * pregunta.
 *
 * ---------------------------------------------------------------------------
 * EL TENANT NO SE COMPRUEBA SOLO AQUI, HAY QUE COMPROBARLO A MANO
 * ---------------------------------------------------------------------------
 * Las otras cuatro herramientas derivan `repoId` de `(tenantId, owner/repo)` y
 * consultan la base: la RLS forzada hace el resto y no hay forma de ver el
 * repositorio de otro. Esta NO pasa por la base para localizar el recurso: mira
 * el sistema de ficheros. Sin una comprobacion explicita, con un
 * `GRAPH_CHECKOUT_ROOT` compartido por varios tenants CUALQUIER `owner/repo`
 * que exista bajo esa raiz devolveria nombres de autor y fechas de su historial
 * — divulgacion entre tenants por la unica puerta que la RLS no cubre.
 *
 * Por eso `assertRepositoryBelongsToTenant` exige que el repositorio este
 * INDEXADO para el tenant activo antes de tocar el disco. Es una consulta
 * acotada por `repo_id`, que ya viene derivado del tenant, y bajo RLS forzada:
 * si el repo es de otro, devuelve cero filas y aqui se rechaza.
 *
 * ---------------------------------------------------------------------------
 * RANKING
 * ---------------------------------------------------------------------------
 * No aplica: esta herramienta no descubre ni expande nada, resuelve un
 * `path -> persona` por cada fichero PEDIDO. El orden de salida es el orden de
 * entrada; lo unico que puede recortar el presupuesto de bytes es el numero de
 * ficheros a la vez (tope `MAX_FILES`), no un ranking.
 */

const run = promisify(execFile)

/** Ficheros por llamada. Cada uno es un `git log` propio; ver `GIT_CONCURRENCY`. */
const MAX_FILES = 200
/** Procesos `git` en paralelo. Generoso para E/S, acotado para no saturar la maquina del daemon. */
const GIT_CONCURRENCY = 8
/** Separador que no puede aparecer en un nombre, correo, sha ni fecha ISO. */
const FIELD_SEP = '\x1f'

export const whoLastTouchedInputShape = {
  repository: repositorySchema.describe('El repositorio, como "owner/repo".'),
  files: z
    .array(relativeFilePathSchema)
    .min(1)
    .max(MAX_FILES)
    .describe('Rutas relativas cuyo ultimo commit se quiere consultar.'),
}

export interface WhoLastTouchedToolInput {
  readonly repository: string
  readonly files: readonly string[]
}

interface LastCommit {
  readonly sha: string
  readonly authorName: string
  readonly authorEmail: string
  readonly authoredAt: string
}

interface TouchedFile {
  readonly path: string
  readonly found: boolean
  /** Nombre de persona. `undefined` solo si `found` es `false`. */
  readonly person?: string
  /** `'user'` si el correo del commit coincide con un usuario del tenant; `'git'` si no. */
  readonly source?: 'user' | 'git'
  readonly lastTouchedAt?: string
  /** Sha corto: trazabilidad, no identidad -- la identidad la da `person`. */
  readonly commit?: string
}

async function lastCommitForFile(repoPath: string, file: string): Promise<LastCommit | undefined> {
  const { stdout } = await run(
    'git',
    [
      '-C',
      repoPath,
      'log',
      '-1',
      `--format=%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI`,
      '--',
      file,
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  )
  const trimmed = stdout.trim()
  if (trimmed === '') return undefined // El fichero no aparece en el historial de este checkout.

  const [sha, authorName, authorEmail, authoredAt] = trimmed.split(FIELD_SEP)
  if (
    sha === undefined ||
    authorName === undefined ||
    authorEmail === undefined ||
    authoredAt === undefined
  ) {
    throw new Error(
      `\`git log\` devolvio una linea con forma inesperada para "${file}": ${trimmed}`,
    )
  }
  return { sha, authorName, authorEmail: authorEmail.toLowerCase(), authoredAt }
}

/** `email -> display_name`, solo para los tenant del contexto activo. */
async function lookupDisplayNamesByEmail(emails: readonly string[]): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map()
  return withTenantConnection(async (tx) => {
    const result = await tx.query<{ email: string; display_name: string }>(
      `SELECT email, display_name FROM users WHERE tenant_id = $1 AND email = ANY($2::text[])`,
      [tx.tenantId, emails],
    )
    return new Map(result.rows.map((row) => [row.email, row.display_name]))
  })
}

/**
 * El repositorio pedido tiene que existir EN EL GRAFO DE ESTE TENANT. Ver la
 * cabecera: es lo unico que separa a esta herramienta de leer el historial de
 * cualquier checkout que haya bajo la raiz configurada.
 */
async function assertRepositoryBelongsToTenant(repository: string): Promise<void> {
  const repoId = resolveRepoId(repository)
  const known = await withTenantConnection(async (tx) => {
    const result = await tx.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM graph_nodes
          WHERE tenant_id = $1 AND repo_id = $2
       ) AS exists`,
      [tx.tenantId, repoId],
    )
    return result.rows[0]?.exists === true
  })
  if (!known) {
    throw new Error(
      `El repositorio "${repository}" no esta indexado para este tenant, asi que no se consulta ` +
        'su historial. Indexalo primero (ingesta del grafo): leer el `git log` de un checkout que ' +
        'no es de este tenant seria filtrar datos de otro cliente.',
    )
  }
}

export async function runWhoLastTouched(
  config: GraphMcpServerConfig,
  input: WhoLastTouchedToolInput,
): Promise<Budgeted<TouchedFile>> {
  // ANTES de tocar el sistema de ficheros, y antes incluso de mirar si hay
  // checkout: que exista o no un directorio ya es informacion.
  await assertRepositoryBelongsToTenant(input.repository)

  if (config.checkoutRoot === undefined) {
    throw new Error(
      'who_last_touched necesita GRAPH_CHECKOUT_ROOT: sin un checkout local no hay `git log` que ' +
        'consultar. Configura la variable al arrancar el servidor MCP (ver packages/graph/README.md).',
    )
  }
  const repoPath = resolveCheckoutPath(config.checkoutRoot, input.repository)
  try {
    await access(repoPath)
  } catch (error) {
    throw new Error(
      `No hay checkout de "${input.repository}" en ${repoPath}: ${(error as Error).message}`,
    )
  }

  const limit = pLimit(GIT_CONCURRENCY)
  const commits = await Promise.all(
    input.files.map((file) =>
      limit(async () => ({ file, commit: await lastCommitForFile(repoPath, file) })),
    ),
  )

  const emails = [
    ...new Set(commits.map((c) => c.commit?.authorEmail).filter((e) => e !== undefined)),
  ]
  const displayNameByEmail = await lookupDisplayNamesByEmail(emails)

  const touched: TouchedFile[] = commits.map(({ file, commit }) => {
    if (commit === undefined) {
      return { path: file, found: false }
    }
    const displayName = displayNameByEmail.get(commit.authorEmail)
    return {
      path: file,
      found: true,
      person: displayName ?? commit.authorName,
      source: displayName !== undefined ? 'user' : 'git',
      lastTouchedAt: commit.authoredAt,
      commit: commit.sha.slice(0, 12),
    }
  })

  return truncateToBudget(touched)
}
