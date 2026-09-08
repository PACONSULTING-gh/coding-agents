import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { uuidSchema, ValidationError } from '@coord/core'
import { withTenantConnection, type TenantQuery } from '@coord/db'
import pLimit from 'p-limit'
import { z } from 'zod'

import type { EdgeKind } from '../queries.js'
import {
  parserForPath,
  type LanguageParser,
  type ParsedFile,
  type ResolvedSpecifier,
} from '../parse/index.js'

import {
  EMPTY_STATS,
  type IngestionCheckpoint,
  type IngestionPhase,
  type IngestionStats,
} from './checkpoint.js'
import { listTrackedFiles, resolveHeadCommit } from './git.js'
import {
  readWorkspacePackages,
  resolveWorkspaceSpecifier,
  type WorkspacePackages,
} from './workspace.js'
import {
  createIngestion,
  deleteStaticEdgesFrom,
  failIngestion,
  fileNodeIds,
  findResumableIngestion,
  insertEdges,
  loadIndexedFiles,
  lookupSymbolNodes,
  removeFiles,
  replaceSymbols,
  resumeIngestion,
  saveCheckpoint,
  symbolKey,
  upsertFileNodes,
  upsertIndexedFiles,
  upsertPackageNodes,
  type EdgeInput,
  type SymbolNodeInput,
} from './store.js'

/**
 * Ingesta del grafo: de un repositorio en disco a `graph_nodes`/`graph_edges`.
 *
 * ===========================================================================
 * LAS TRES PROPIEDADES QUE GOBIERNAN ESTE FICHERO
 * ===========================================================================
 *
 * 1. INCREMENTAL. Un fichero cuyo `content_hash` no cambio NO se lee para
 *    parsear, NO se reparsea y sus aristas NO se tocan. No es una optimizacion
 *    que se pueda quitar: un rebuild completo no sobrevive a un repo grande, y
 *    el epic dice explicitamente que retrofitear esto despues sale caro.
 *
 * 2. REANUDABLE. El estado vive en `graph_ingestions.checkpoint` y se escribe
 *    EN LA MISMA TRANSACCION que los datos del lote. Si el proceso muere de un
 *    SIGKILL entre dos lotes, lo confirmado esta confirmado y el checkpoint
 *    dice exactamente por donde iba. Nada relevante vive solo en memoria.
 *
 * 3. SIN ARISTAS FANTASMA. Lo que no se resuelve NO se inventa: se descarta y
 *    se cuenta (`unresolvedImports`, `unresolvedReferences`). Un grafo con
 *    aristas inventadas es peor que uno incompleto, porque nadie sabe cuales
 *    creerse, y todo lo que se construye encima —radio de impacto, colisiones—
 *    hereda la mentira.
 *
 * ===========================================================================
 * POLITICA DE RESOLUCION (resumen; el detalle esta en el README del paquete)
 * ===========================================================================
 *   * Import relativo que casa con un fichero seguido por git -> arista al nodo
 *     `file` de ese fichero. Incluye la reescritura de extension del ESM de
 *     TypeScript (`./x.js` -> `x.ts`) y `dir/index.ts`.
 *   * Especificador nudo (`pg`, `@coord/db`, `node:fs`, `os`) -> nodo
 *     `package`. El paquete existe de verdad; lo que no se hace es fingir que
 *     apunta a un fichero del repo.
 *   * Cualquier otra cosa -> NO se crea arista, y sube `unresolvedImports`.
 *   * `calls`/`inherits` se resuelven a un simbolo del MISMO fichero, o a uno
 *     importado POR NOMBRE (o via `ns.foo`) desde un fichero que si resolvio.
 *     Un `import por defecto` no dice que nombre tiene el simbolo en su modulo
 *     de origen, asi que no se resuelve.
 */

/** Tope de tamano por fichero. Por encima, no se parsea y se cuenta aparte. */
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024

/** Ficheros por lote. Un lote = una transaccion = un punto de reanudacion. */
const DEFAULT_BATCH_SIZE = 200

/**
 * Ficheros leidos y parseados a la vez.
 *
 * tree-sitter es SINCRONO: esto no paraleliza CPU, y ponerlo a 5.000 no haria
 * la ingesta mas rapida. Lo que acota es la lectura de disco simultanea y,
 * sobre todo, cuantos arboles sintacticos hay vivos en memoria a la vez. Sin
 * tope, un lote grande de ficheros grandes se lee entero antes de parsear nada.
 */
const DEFAULT_CONCURRENCY = 8

/** Aristas que produce cada fase. Es lo que esa fase borra antes de regenerar. */
const SYMBOL_PHASE_EDGE_KINDS: readonly EdgeKind[] = ['contains', 'imports']
const REFERENCE_PHASE_EDGE_KINDS: readonly EdgeKind[] = ['calls', 'inherits']

/**
 * SUPERFICIE DE TEST DECLARADA, y se dice a proposito.
 *
 * Estos dos puntos de extension existen para que un test pueda cortar la
 * ingesta en un punto conocido y comprobar que la reanudacion no da por hecho
 * nada de lo que no llego a confirmarse. No los usa ningun camino de
 * produccion, y es mejor tenerlos declarados y explicados que simular una caida
 * con un `kill -9` desde el test, que seria mucho mas fragil.
 *
 * Lo que NO prueban: la atomicidad "datos del lote y checkpoint en la misma
 * transaccion". La interrupcion que permiten ocurre siempre durante el PARSEO,
 * antes de que el lote abra transaccion. Esa propiedad tiene su propio test
 * (`test/ingest.test.ts`, "3 bis"), que escribe por las mismas funciones de
 * `store.ts` dentro de una transaccion que despues falla.
 */
export interface IngestionHooks {
  /**
   * Se invoca tras parsear cada fichero, ANTES de que su lote se confirme.
   * Puede lanzar: eso aborta la ingesta a mitad de lote.
   */
  readonly onFileParsed?: (info: { path: string; phase: IngestionPhase }) => void
  /** Se invoca cuando el lote YA esta confirmado en la base. Puede lanzar. */
  readonly onBatchCommitted?: (info: {
    phase: IngestionPhase
    nextIndex: number
    total: number
  }) => void | Promise<void>
}

const inputSchema = z.object({
  repoId: uuidSchema,
  /** Directorio del repositorio en disco. Tiene que ser un repositorio git. */
  repoPath: z.string().min(1),
  /** Por defecto, HEAD del repositorio. */
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .optional(),
  batchSize: z.number().int().min(1).max(5000).default(DEFAULT_BATCH_SIZE),
  concurrency: z.number().int().min(1).max(64).default(DEFAULT_CONCURRENCY),
  maxFileBytes: z.number().int().min(1).default(DEFAULT_MAX_FILE_BYTES),
})

export type IngestRepositoryInput = z.input<typeof inputSchema> & { hooks?: IngestionHooks }

export interface IngestionResult extends IngestionStats {
  readonly ingestionId: string
  readonly commitSha: string
  /** `true` si esta llamada continuo una ingesta anterior en vez de empezar. */
  readonly resumed: boolean
  readonly durationMs: number
}

interface ParsedEntry {
  readonly path: string
  readonly parser: LanguageParser
  readonly hash: string
  readonly parsed: ParsedFile
}

interface SkippedEntry {
  readonly path: string
  readonly parser: LanguageParser
  readonly hash: string
  readonly parsed: undefined
}

type BatchEntry = ParsedEntry | SkippedEntry

/**
 * Indexa un repositorio. Exige contexto de tenant activo (`runWithTenant`):
 * todo el acceso pasa por `withTenantConnection`, que falla ruidosamente si no
 * lo hay.
 */
export async function ingestRepository(input: IngestRepositoryInput): Promise<IngestionResult> {
  const parsedInput = inputSchema.safeParse(input)
  if (!parsedInput.success) {
    throw new ValidationError(
      `Entrada invalida para ingestRepository: ${parsedInput.error.message}`,
      {
        cause: parsedInput.error,
      },
    )
  }
  const options = parsedInput.data
  const hooks = input.hooks ?? {}
  const startedAt = Date.now()

  // El `commitSha` que llega de fuera (el `after` de un push, ver
  // `apps/worker/src/graph-ingestion.ts`) es una AFIRMACION del llamante sobre
  // el estado del checkout, y se comprueba: si no coincide con HEAD se indexaria
  // el contenido de un commit sellandolo con la etiqueta de otro, y la siguiente
  // ingesta daria esos ficheros por "sin cambios" al comparar hashes. Un grafo
  // que afirma reflejar un commit que no ha visto es peor que no tener grafo.
  const head = await resolveHeadCommit(options.repoPath)
  if (options.commitSha !== undefined && !sameCommit(options.commitSha, head)) {
    throw new ValidationError(
      `El checkout de ${options.repoPath} esta en ${head} y se pidio indexar ${options.commitSha}. ` +
        'Haz el checkout del commit pedido antes de ingerir: indexar el arbol de trabajo con la ' +
        'etiqueta de otro commit deja el grafo desincronizado en silencio.',
    )
  }
  const commitSha = options.commitSha ?? head

  // Todos los ficheros seguidos por git que algun parser sabe leer. Es el
  // universo contra el que se resuelven los imports, tambien al reanudar.
  const tracked = await listTrackedFiles(options.repoPath)
  const indexable = tracked.filter((file) => parserForPath(file) !== undefined).sort()
  const fileIndex = new Set(indexable)
  // Paquetes locales del monorepo, para que los imports entre paquetes sean
  // aristas de verdad y no callejones sin salida. Ver `workspace.ts`.
  const workspace = await readWorkspacePackages(options.repoPath, tracked, fileIndex)

  const opened = await openIngestion(options.repoId, commitSha, indexable, options.repoPath, {
    maxFileBytes: options.maxFileBytes,
    concurrency: options.concurrency,
  })

  let checkpoint = opened.checkpoint
  try {
    while (checkpoint.phase !== 'completed') {
      if (checkpoint.nextIndex >= checkpoint.files.length) {
        checkpoint = { ...checkpoint, phase: nextPhase(checkpoint.phase), nextIndex: 0 }
        await withTenantConnection((tx) => saveCheckpoint(tx, opened.ingestionId, checkpoint))
        continue
      }

      const phase = checkpoint.phase
      const batch = checkpoint.files.slice(
        checkpoint.nextIndex,
        checkpoint.nextIndex + options.batchSize,
      )
      const entries = await readAndParseBatch(batch, options, phase, hooks)
      const next = checkpoint.nextIndex + batch.length

      // Datos del lote y checkpoint en la MISMA transaccion: o se confirman los
      // dos, o ninguno. Si se guardaran por separado, un fallo entre medias
      // dejaria el checkpoint diciendo que un trabajo se hizo cuando no.
      checkpoint = await withTenantConnection(async (tx) => {
        const stats =
          phase === 'symbols'
            ? await writeSymbolPhase(tx, options.repoId, entries, fileIndex, workspace, commitSha)
            : await writeReferencePhase(tx, options.repoId, entries, fileIndex, workspace)
        const updated: IngestionCheckpoint = {
          ...checkpoint,
          nextIndex: next,
          stats: addStats(checkpoint.stats, stats),
        }
        await saveCheckpoint(tx, opened.ingestionId, updated)
        return updated
      })

      await hooks.onBatchCommitted?.({
        phase,
        nextIndex: next,
        total: checkpoint.files.length,
      })
    }
  } catch (error) {
    await recordFailure(opened.ingestionId, error)
    throw error
  }

  return {
    ...checkpoint.stats,
    ingestionId: opened.ingestionId,
    commitSha,
    resumed: opened.resumed,
    durationMs: Date.now() - startedAt,
  }
}

function nextPhase(phase: IngestionPhase): IngestionPhase {
  return phase === 'symbols' ? 'references' : 'completed'
}

/**
 * Escribe el fallo CON su motivo y vuelve a lanzar el original. Si ni siquiera
 * se puede registrar el fallo, salen los dos errores: ninguno se traga
 * (CLAUDE.md 5).
 */
async function recordFailure(ingestionId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  try {
    await withTenantConnection((tx) => failIngestion(tx, ingestionId, message))
  } catch (failure) {
    throw new AggregateError(
      [error, failure],
      'La ingesta fallo y ademas no se pudo registrar el fallo en graph_ingestions.',
    )
  }
}

// ---------------------------------------------------------------------------
// Apertura: reanudar lo que quedo a medias, o planificar de cero
// ---------------------------------------------------------------------------

interface OpenedIngestion {
  readonly ingestionId: string
  readonly checkpoint: IngestionCheckpoint
  readonly resumed: boolean
}

/**
 * `true` si los dos sha designan el mismo commit. El llamante puede mandar un
 * sha corto (el CHECK de la migracion acepta de 7 a 40 caracteres), asi que se
 * compara por prefijo del mas corto y no por igualdad literal.
 */
function sameCommit(claimed: string, head: string): boolean {
  const length = Math.min(claimed.length, head.length)
  return claimed.slice(0, length) === head.slice(0, length)
}

/**
 * Ficheros que hay que reparsear AUNQUE su contenido no haya cambiado, porque
 * cambio el conjunto de rutas del repositorio y con el la resolucion de alguno
 * de sus imports.
 *
 * Se resuelve cada especificador guardado (migracion 0009) DOS veces —contra el
 * indice de ficheros anterior y contra el nuevo— y se replanifica el fichero si
 * el resultado cambia. Es exacto: ni de mas (un import a `pg` resuelve igual en
 * los dos y no replanifica nada) ni de menos (cubre tanto el alta de un fichero
 * que satisface un import pendiente como la baja de uno que resolvia).
 *
 * `resolveSpecifier` es una funcion pura sobre cadenas: esto NO lee ni parsea
 * ningun fichero, solo mira los especificadores que ya estaban guardados.
 */
function filesWhoseImportsChangedTarget(
  indexed: ReadonlyMap<string, { readonly importSpecifiers: readonly string[] }>,
  previousIndex: ReadonlySet<string>,
  currentIndex: ReadonlySet<string>,
): string[] {
  const affected: string[] = []
  for (const [file, state] of indexed) {
    if (!currentIndex.has(file)) continue // Ya se trata como borrado.
    if (state.importSpecifiers.length === 0) continue
    const parser = parserForPath(file)
    if (parser === undefined) continue
    for (const specifier of state.importSpecifiers) {
      const before = parser.resolveSpecifier(specifier, file, previousIndex)
      const now = parser.resolveSpecifier(specifier, file, currentIndex)
      if (!sameTarget(before, now)) {
        affected.push(file)
        break
      }
    }
  }
  return affected
}

function sameTarget(a: ResolvedSpecifier, b: ResolvedSpecifier): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path
  if (a.kind === 'package' && b.kind === 'package') return a.name === b.name
  return true
}

async function openIngestion(
  repoId: string,
  commitSha: string,
  indexable: readonly string[],
  repoPath: string,
  limits: { maxFileBytes: number; concurrency: number },
): Promise<OpenedIngestion> {
  const resumable = await withTenantConnection(async (tx) => {
    const found = await findResumableIngestion(tx, repoId, commitSha)
    if (found !== undefined) await resumeIngestion(tx, found.id)
    return found
  })
  if (resumable !== undefined) {
    return { ingestionId: resumable.id, checkpoint: resumable.checkpoint, resumed: true }
  }

  // Planificar exige los hashes actuales de TODOS los ficheros indexables: es la
  // unica forma de saber cuales no han cambiado. Se hace FUERA de la
  // transaccion —es trabajo de disco, no de base de datos— para no tener una
  // transaccion abierta mientras se lee el repositorio entero.
  const hashes = await hashFiles(repoPath, indexable, limits.concurrency)

  return withTenantConnection(async (tx) => {
    const indexed = await loadIndexedFiles(tx, repoId)

    const planned = new Set<string>()
    for (const file of indexable) {
      if (indexed.get(file)?.hash !== hashes.get(file)) planned.add(file)
    }
    const removed = [...indexed.keys()].filter((file) => !hashes.has(file)).sort()

    // El conjunto de rutas indexables cambio (altas o bajas): hay imports que
    // hoy resuelven a otra cosa que ayer, en ficheros que NO han cambiado de
    // hash. Sin esto el grafo se queda desactualizado en silencio; ver la
    // cabecera de la migracion 0009.
    const previousIndex = new Set(indexed.keys())
    const currentIndex = new Set(indexable)
    const pathSetChanged = removed.length > 0 || indexable.some((file) => !previousIndex.has(file))
    if (pathSetChanged) {
      for (const file of filesWhoseImportsChangedTarget(indexed, previousIndex, currentIndex)) {
        planned.add(file)
      }
    }

    const files = [...planned].sort()

    if (removed.length > 0) await removeFiles(tx, repoId, removed)

    // Los nodos de fichero de TODA la pasada, antes de parsear nada: asi un
    // import a un fichero que todavia no toco resuelve igual y el grafo no
    // depende del orden de los lotes.
    await upsertFileNodes(
      tx,
      repoId,
      files.map((file) => ({ path: file, language: languageOf(file) })),
    )

    const checkpoint: IngestionCheckpoint = {
      version: 1,
      phase: 'symbols',
      files,
      removed,
      nextIndex: 0,
      stats: {
        ...EMPTY_STATS,
        totalFiles: indexable.length,
        filesPlanned: files.length,
        filesSkipped: indexable.length - files.length,
        filesRemoved: removed.length,
      },
    }
    const ingestionId = await createIngestion(tx, repoId, commitSha)
    await saveCheckpoint(tx, ingestionId, checkpoint)
    return { ingestionId, checkpoint, resumed: false }
  })
}

// ---------------------------------------------------------------------------
// Lectura y parseo
// ---------------------------------------------------------------------------

function languageOf(file: string): string {
  const parser = parserForPath(file)
  if (parser === undefined) {
    throw new Error(`Ningun parser atiende ${file}; no deberia estar en el plan.`)
  }
  return parser.language
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Hash de cada fichero indexable. Un fichero que git sigue pero que no esta en
 * el arbol de trabajo NO tumba la pasada entera: se trata como borrado (no entra
 * en el mapa, con lo que `openIngestion` lo mete en `removed`). Propagar un
 * ENOENT crudo aqui aborta ANTES de crear la fila de `graph_ingestions`, asi que
 * no quedaria ni rastro del fallo en la base. Cualquier OTRO error de lectura
 * —permisos, disco— SI se propaga (CLAUDE.md 5: nada de catch silencioso de lo
 * que no se sabe manejar).
 */
async function hashFiles(
  repoPath: string,
  files: readonly string[],
  concurrency: number,
): Promise<Map<string, string>> {
  const limit = pLimit(concurrency)
  const hashes = new Map<string, string>()
  await Promise.all(
    files.map((file) =>
      limit(async () => {
        try {
          hashes.set(file, sha256(await readFile(path.join(repoPath, file))))
        } catch (error) {
          if (!isMissingFile(error)) throw error
        }
      }),
    ),
  )
  return hashes
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

async function readAndParseBatch(
  batch: readonly string[],
  options: { repoPath: string; concurrency: number; maxFileBytes: number },
  phase: IngestionPhase,
  hooks: IngestionHooks,
): Promise<BatchEntry[]> {
  const limit = pLimit(options.concurrency)
  return Promise.all(
    batch.map((file) =>
      limit(async (): Promise<BatchEntry> => {
        const parser = parserForPath(file)
        if (parser === undefined) {
          throw new Error(`Ningun parser atiende ${file}; no deberia estar en el plan.`)
        }
        const content = await readFile(path.join(options.repoPath, file))
        const hash = sha256(content)
        if (content.byteLength > options.maxFileBytes) {
          // No se parsea, pero SI se registra su hash: si no, se replanificaria
          // en cada pasada y volveria a leerse el repo entero para nada.
          return { path: file, parser, hash, parsed: undefined }
        }
        const parsed = parser.parse(content.toString('utf8'), file)
        hooks.onFileParsed?.({ path: file, phase })
        return { path: file, parser, hash, parsed }
      }),
    ),
  )
}

// ---------------------------------------------------------------------------
// Fase 1: simbolos, `contains` e `imports`
// ---------------------------------------------------------------------------

/**
 * Resuelve un import a su destino final, reescribiendo los paquetes LOCALES del
 * monorepo a su fichero de entrada.
 *
 * Sin esta reescritura, `import ... from '@coord/core'` acaba en un nodo
 * `package` sin aristas de salida y el grafo se corta en la frontera de cada
 * paquete — que en un monorepo es donde estan casi todas las dependencias
 * interesantes. Ver la cabecera de `workspace.ts`.
 */
function resolveImportTarget(
  entry: BatchEntry,
  specifier: string,
  fileIndex: ReadonlySet<string>,
  workspace: WorkspacePackages,
): ResolvedSpecifier {
  const target = entry.parser.resolveSpecifier(specifier, entry.path, fileIndex)
  if (target.kind !== 'package') return target
  const local = resolveWorkspaceSpecifier(specifier, workspace, fileIndex)
  return local === undefined ? target : { kind: 'file', path: local }
}

type BatchStats = Partial<IngestionStats>

async function writeSymbolPhase(
  tx: TenantQuery,
  repoId: string,
  entries: readonly BatchEntry[],
  fileIndex: ReadonlySet<string>,
  workspace: WorkspacePackages,
  commitSha: string,
): Promise<BatchStats> {
  const paths = entries.map((entry) => entry.path)

  const symbols: SymbolNodeInput[] = []
  for (const entry of entries) {
    if (entry.parsed === undefined) continue
    for (const symbol of entry.parsed.symbols) {
      symbols.push({
        path: entry.path,
        name: symbol.name,
        symbolKind: symbol.symbolKind,
        language: entry.parser.language,
      })
    }
  }
  const symbolIds = await replaceSymbols(tx, repoId, paths, symbols)

  // Destinos de los imports, ya resueltos: ficheros del repo y paquetes.
  const targetPaths = new Set<string>(paths)
  const packageNames = new Set<string>()
  let unresolvedImports = 0
  const resolvedByFile = new Map<string, { kind: 'file' | 'package'; key: string }[]>()

  for (const entry of entries) {
    if (entry.parsed === undefined) continue
    const targets: { kind: 'file' | 'package'; key: string }[] = []
    for (const imported of entry.parsed.imports) {
      const target = resolveImportTarget(entry, imported.specifier, fileIndex, workspace)
      if (target.kind === 'file') {
        targetPaths.add(target.path)
        targets.push({ kind: 'file', key: target.path })
      } else if (target.kind === 'package') {
        packageNames.add(target.name)
        targets.push({ kind: 'package', key: target.name })
      } else {
        unresolvedImports += 1
      }
    }
    resolvedByFile.set(entry.path, targets)
  }

  const fileIds = await fileNodeIds(tx, repoId, [...targetPaths])
  const packageIds: ReadonlyMap<string, string> =
    packageNames.size > 0
      ? await upsertPackageNodes(tx, repoId, [...packageNames])
      : new Map<string, string>()

  await deleteStaticEdgesFrom(tx, repoId, paths, SYMBOL_PHASE_EDGE_KINDS)

  const edges = new EdgeSet()
  for (const entry of entries) {
    const fromId = fileIds.get(entry.path)
    if (fromId === undefined || entry.parsed === undefined) continue

    for (const symbol of entry.parsed.symbols) {
      const symbolId = symbolIds.get(symbolKey(entry.path, symbol.name))
      if (symbolId !== undefined) edges.add(fromId, symbolId, 'contains')
    }
    for (const target of resolvedByFile.get(entry.path) ?? []) {
      const toId = target.kind === 'file' ? fileIds.get(target.key) : packageIds.get(target.key)
      if (toId !== undefined) edges.add(fromId, toId, 'imports')
      else unresolvedImports += 1
    }
  }

  const inserted = await insertEdges(tx, repoId, edges.values())

  // Los especificadores se persisten TAL CUAL aparecen en el codigo, no ya
  // resueltos: es lo que permite volver a resolverlos contra otro conjunto de
  // rutas cuando el repo gana o pierde ficheros (migracion 0009).
  await upsertIndexedFiles(
    tx,
    repoId,
    entries.map((entry) => ({
      path: entry.path,
      hash: entry.hash,
      language: entry.parser.language,
      importSpecifiers: (entry.parsed?.imports ?? []).map((imported) => imported.specifier),
    })),
    commitSha,
  )

  return {
    filesParsed: entries.filter((entry) => entry.parsed !== undefined).length,
    filesTooLarge: entries.filter((entry) => entry.parsed === undefined).length,
    nodesUpserted: symbolIds.size + entries.length,
    edgesInserted: inserted,
    unresolvedImports,
  }
}

// ---------------------------------------------------------------------------
// Fase 2: `calls` e `inherits`
// ---------------------------------------------------------------------------

interface PendingReference {
  readonly fromPath: string
  readonly fromSymbol: string | null
  readonly toPath: string
  readonly toName: string
  readonly kind: EdgeKind
}

async function writeReferencePhase(
  tx: TenantQuery,
  repoId: string,
  entries: readonly BatchEntry[],
  fileIndex: ReadonlySet<string>,
  workspace: WorkspacePackages,
): Promise<BatchStats> {
  const paths = entries.map((entry) => entry.path)
  const pending: PendingReference[] = []
  let unresolvedReferences = 0

  for (const entry of entries) {
    if (entry.parsed === undefined) continue

    // Ligaduras de este fichero: que nombre local viene de que fichero y con
    // que nombre alli. Solo cuentan los imports que resolvieron a un FICHERO.
    const named = new Map<string, { path: string; name: string }>()
    const namespaces = new Map<string, string>()
    for (const imported of entry.parsed.imports) {
      const target = resolveImportTarget(entry, imported.specifier, fileIndex, workspace)
      if (target.kind !== 'file') continue
      for (const binding of imported.bindings) {
        if (binding.kind === 'named' && binding.imported !== null) {
          named.set(binding.local, { path: target.path, name: binding.imported })
        } else if (binding.kind === 'namespace') {
          namespaces.set(binding.local, target.path)
        }
      }
    }
    const local = new Set(entry.parsed.symbols.map((symbol) => symbol.name))

    const push = (kind: EdgeKind, references: ParsedFile['calls']): void => {
      for (const reference of references) {
        let target: { path: string; name: string } | undefined
        if (reference.namespace !== null) {
          const namespacePath = namespaces.get(reference.namespace)
          target =
            namespacePath === undefined ? undefined : { path: namespacePath, name: reference.name }
        } else if (local.has(reference.name)) {
          target = { path: entry.path, name: reference.name }
        } else {
          target = named.get(reference.name)
        }
        if (target === undefined) {
          unresolvedReferences += 1
          continue
        }
        pending.push({
          fromPath: entry.path,
          fromSymbol: reference.from,
          toPath: target.path,
          toName: target.name,
          kind,
        })
      }
    }

    push('calls', entry.parsed.calls)
    push('inherits', entry.parsed.inherits)
  }

  // Una sola busqueda para las dos puntas: el simbolo que llama y el llamado.
  const wanted = new Map<string, { path: string; name: string }>()
  for (const reference of pending) {
    wanted.set(symbolKey(reference.toPath, reference.toName), {
      path: reference.toPath,
      name: reference.toName,
    })
    if (reference.fromSymbol !== null) {
      wanted.set(symbolKey(reference.fromPath, reference.fromSymbol), {
        path: reference.fromPath,
        name: reference.fromSymbol,
      })
    }
  }
  const symbolIds = await lookupSymbolNodes(tx, repoId, [...wanted.values()])
  const fileIds = await fileNodeIds(tx, repoId, paths)

  await deleteStaticEdgesFrom(tx, repoId, paths, REFERENCE_PHASE_EDGE_KINDS)

  const edges = new EdgeSet()
  for (const reference of pending) {
    const toId = symbolIds.get(symbolKey(reference.toPath, reference.toName))
    const fromId =
      reference.fromSymbol === null
        ? fileIds.get(reference.fromPath)
        : symbolIds.get(symbolKey(reference.fromPath, reference.fromSymbol))
    if (toId === undefined || fromId === undefined) {
      // El simbolo destino no existe en el grafo: la referencia apuntaba a algo
      // que no declaramos como simbolo. No se inventa una arista.
      unresolvedReferences += 1
      continue
    }
    edges.add(fromId, toId, reference.kind)
  }

  const inserted = await insertEdges(tx, repoId, edges.values())

  return {
    filesParsed: entries.filter((entry) => entry.parsed !== undefined).length,
    edgesInserted: inserted,
    unresolvedReferences,
  }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/**
 * Aristas del lote sin repetir y sin bucles a si mismo. `A llama a A` es cierto
 * pero no aporta nada a "si toco esto, que mas se ve afectado", que es la unica
 * pregunta que este grafo existe para responder.
 */
class EdgeSet {
  private readonly seen = new Set<string>()
  private readonly edges: EdgeInput[] = []

  add(from: string, to: string, kind: EdgeKind): void {
    if (from === to) return
    const key = `${from}|${to}|${kind}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.edges.push({ from, to, kind })
  }

  values(): readonly EdgeInput[] {
    return this.edges
  }
}

function addStats(base: IngestionStats, delta: BatchStats): IngestionStats {
  const result: IngestionStats = { ...base }
  for (const [key, value] of Object.entries(delta)) {
    if (typeof value === 'number') {
      result[key as keyof IngestionStats] += value
    }
  }
  return result
}
