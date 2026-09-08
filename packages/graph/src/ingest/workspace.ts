import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

/**
 * Paquetes locales del repo: nombre del paquete -> fichero de entrada, EN CODIGO
 * FUENTE.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EXISTE ESTO
 * ---------------------------------------------------------------------------
 * En un monorepo, `import { requireTenant } from '@coord/core'` es una
 * dependencia real entre dos ficheros del repo, pero un resolvedor que solo
 * conoce rutas lo clasifica como paquete externo. El resultado medido: un nodo
 * `package` sin ninguna arista de salida, y `blast_radius` sobre
 * `packages/core/src/tenant.ts` devolviendo 2 afectados —ambos dentro de
 * `packages/core`— cuando `packages/db`, `queue`, `webhook` y `worker` dependen
 * de el de verdad.
 *
 * Con el repo en monorepo (decision cerrada en CLAUDE.md 3), ese hueco se come
 * casi todo lo interesante que el grafo tiene que decir.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EN EL MOTOR Y NO EN EL PARSER
 * ---------------------------------------------------------------------------
 * Un workspace de pnpm no es un concepto del lenguaje: es del repositorio.
 * Python no tiene `pnpm-workspace.yaml`. Meterlo en `resolveSpecifier` obligaria
 * a que cada parser conociera la disposicion del repo, que es justo la frontera
 * que `LanguageParser` existe para no cruzar.
 *
 * Un paquete que NO sea local sigue siendo un nodo `package`, como antes: esto
 * solo reescribe el destino cuando el paquete vive en este repo.
 */
export type WorkspacePackages = ReadonlyMap<string, string>

/** Entradas declaradas que nos interesan de un `package.json`. */
interface Manifest {
  readonly name?: unknown
  readonly exports?: unknown
  readonly main?: unknown
  readonly module?: unknown
}

/** Saca la ruta de entrada declarada, sin resolverla todavia. */
function declaredEntry(manifest: Manifest): string | undefined {
  const exports = manifest.exports
  if (typeof exports === 'string') return exports
  if (exports !== null && typeof exports === 'object') {
    const root = (exports as Record<string, unknown>)['.'] ?? exports
    if (typeof root === 'string') return root
    if (root !== null && typeof root === 'object') {
      // Orden deliberado: la condicion `import` es la que usa este repo (ESM).
      for (const key of ['import', 'default', 'require', 'node']) {
        const value = (root as Record<string, unknown>)[key]
        if (typeof value === 'string') return value
      }
    }
  }
  if (typeof manifest.module === 'string') return manifest.module
  if (typeof manifest.main === 'string') return manifest.main
  return undefined
}

/**
 * Candidatos de fuente para una entrada declarada.
 *
 * Lo declarado apunta al artefacto compilado (`./dist/index.js`), que esta en
 * `.gitignore` y por tanto NO esta en el indice: hay que volver a la fuente.
 * El mapeo `dist -> src` y `.js -> .ts` cubre la convencion de este repo; los
 * fallbacks cubren los layouts habituales. Se prueba en orden y gana el primero
 * que exista de verdad en el indice — nunca se inventa una ruta.
 */
function sourceCandidates(packageDir: string, entry: string | undefined): string[] {
  const candidates: string[] = []
  const push = (relative: string): void => {
    const full = packageDir === '' ? relative : posix.join(packageDir, relative)
    if (!candidates.includes(full)) candidates.push(full)
  }

  if (entry !== undefined) {
    const clean = entry.replace(/^\.\//, '')
    push(clean)
    const fromDist = clean.replace(/^dist\//, 'src/')
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
      push(fromDist.replace(/\.(?:js|mjs|cjs)$/, ext))
      push(clean.replace(/\.(?:js|mjs|cjs)$/, ext))
    }
    push(fromDist)
  }

  for (const fallback of [
    'src/index.ts',
    'src/index.tsx',
    'src/index.mts',
    'index.ts',
    'src/index.js',
    'index.js',
  ]) {
    push(fallback)
  }
  return candidates
}

/**
 * Construye el mapa leyendo los `package.json` que git tiene seguidos.
 *
 * Un manifiesto ilegible o sin `name` se ignora en silencio **a proposito**: no
 * todo `package.json` de un repo describe un paquete importable, y abortar la
 * ingesta entera por uno mal formado seria desproporcionado. Lo que nunca se
 * hace es apuntar a un fichero que no existe.
 */
export async function readWorkspacePackages(
  repoPath: string,
  tracked: readonly string[],
  fileIndex: ReadonlySet<string>,
): Promise<WorkspacePackages> {
  const manifests = tracked.filter(
    (path) =>
      (path === 'package.json' || path.endsWith('/package.json')) &&
      !path.includes('node_modules/'),
  )

  const packages = new Map<string, string>()
  await Promise.all(
    manifests.map(async (manifestPath) => {
      let manifest: Manifest
      try {
        manifest = JSON.parse(await readFile(join(repoPath, manifestPath), 'utf8')) as Manifest
      } catch {
        return
      }
      if (typeof manifest.name !== 'string' || manifest.name === '') return

      const packageDir = manifestPath.slice(0, Math.max(0, manifestPath.lastIndexOf('/')))
      for (const candidate of sourceCandidates(packageDir, declaredEntry(manifest))) {
        if (fileIndex.has(candidate)) {
          packages.set(manifest.name, candidate)
          return
        }
      }
    }),
  )
  return packages
}

/**
 * Traduce un import a un paquete local en su fichero de entrada.
 *
 * Cubre tambien los subpath imports (`@coord/db/migrate`): si el subpath no
 * resuelve a un fichero real, se cae a la entrada del paquete, que sigue siendo
 * una arista cierta —ese import depende de ese paquete— aunque menos precisa.
 * Devuelve `undefined` para cualquier paquete que no sea de este repo.
 */
export function resolveWorkspaceSpecifier(
  specifier: string,
  packages: WorkspacePackages,
  fileIndex: ReadonlySet<string>,
): string | undefined {
  const direct = packages.get(specifier)
  if (direct !== undefined) return direct

  // `@scope/name/sub/path` -> paquete `@scope/name`, subpath `sub/path`.
  const segments = specifier.split('/')
  const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  if (packageName === undefined) return undefined
  const entry = packages.get(packageName)
  if (entry === undefined) return undefined

  const subpath = specifier.slice(packageName.length + 1)
  if (subpath === '') return entry

  const packageDir = entry.slice(0, Math.max(0, entry.lastIndexOf('/')))
  const srcDir = packageDir.endsWith('/src') ? packageDir : posix.join(packageDir, 'src')
  for (const ext of ['.ts', '.tsx', '.mts', '.js']) {
    const candidate = posix.join(srcDir, subpath.replace(/\.(?:js|mjs|cjs)$/, '') + ext)
    if (fileIndex.has(candidate)) return candidate
  }
  return entry
}
