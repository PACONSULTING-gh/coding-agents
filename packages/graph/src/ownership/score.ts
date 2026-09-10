import { ValidationError } from '@coord/core'

import { DEFAULT_MAX_FILES_PER_COMMIT } from '../cochange/mine.js'

import type { AuthorshipCommit } from './git.js'

/**
 * Ownership por fichero (epic 03 / T01), a partir del historial que lee
 * `git.ts`.
 *
 * Es PURO a proposito: no ejecuta git, no toca la base de datos. Se le da una
 * lista de commits y devuelve quien tiene evidencia de autoria sobre cada
 * fichero. Asi la regla —lo unico que hay que discutir cuando alguien diga que
 * el ranking esta mal— se prueba en milisegundos.
 *
 * ===========================================================================
 * EL COMMIT DE REFORMATEO SE DESCARTA ENTERO. NO SE DILUYE.
 * ===========================================================================
 * Es el criterio de aceptacion con dientes de T01, y la decision NO es nueva:
 * este repositorio ya la tomo para el minado de co-cambio, y se reutiliza la
 * misma constante (`DEFAULT_MAX_FILES_PER_COMMIT`, 50) y el mismo razonamiento
 * escrito en `cochange/mine.ts`:
 *
 *   > Un commit asi NO es un cambio logico cohesionado, es una operacion
 *   > mecanica (formateo masivo, subida de dependencias, ficheros generados,
 *   > un merge): se DESCARTA ENTERO, no se trunca su lista de ficheros.
 *
 * La alternativa que se considero y se descarto fue ponderar cada commit por
 * `1 / ficheros_del_commit`, que DILUYE el reformateo en vez de quitarlo. Es
 * peor por lo mismo que alli se dice de truncar: deja señal residual y
 * arbitraria donde no hay ninguna. Un `format all` no aporta "poca" evidencia
 * de autoria sobre 400 ficheros, aporta CERO.
 *
 * ===========================================================================
 * SE ORDENA POR LINEAS, NO POR NUMERO DE COMMITS
 * ===========================================================================
 * El criterio dice "por evidencia real de autoria, NO por numero bruto de
 * commits". Contar commits por fichero seria eso mismo con otro nombre: quien
 * cambio una linea y quien escribio el fichero entero valdrian igual. Se
 * ordena por lineas tocadas dentro de la ventana, y el numero de commits queda
 * como desempate y como dato citable.
 */

/** Cuanta evidencia de autoria tiene una persona sobre un fichero. */
export interface OwnerEvidence {
  /** Email en minusculas: la identidad estable. */
  readonly authorEmail: string
  /** Ultimo nombre visto para ese email. Para enseñarselo a un humano. */
  readonly authorName: string
  /** Lineas añadidas + borradas sobre ESTE fichero, dentro de la ventana. */
  readonly lines: number
  /** Commits que tocaron ESTE fichero, tras descartar los mecanicos. */
  readonly commits: number
  /** Proporcion sobre el total del fichero, en [0, 1]. Es lo que se cita. */
  readonly share: number
  readonly lastTouchedAt: Date
}

export interface FileOwnership {
  readonly path: string
  /** De mas a menos evidencia. Vacio si nadie lo toco dentro de la ventana. */
  readonly owners: readonly OwnerEvidence[]
  /** Commits contados para este fichero, tras los descartes. */
  readonly commits: number
}

export interface OwnershipOptions {
  /**
   * Por encima de esto, el commit se descarta ENTERO. Por defecto, la misma
   * constante que usa el co-cambio: el numero correcto depende del equipo, no
   * es una ley fisica.
   */
  readonly maxFilesPerCommit?: number
  /**
   * Shas que no cuentan, ademas del tope de ficheros. Sirve para alimentar
   * `.git-blame-ignore-revs`, que es el mecanismo NATIVO de git para marcar
   * commits mecanicos: si el repositorio lo mantiene, es mejor señal que
   * cualquier heuristica nuestra, porque la puso una persona a mano.
   */
  readonly ignoreShas?: readonly string[]
}

export interface OwnershipResult {
  readonly files: readonly FileOwnership[]
  /** Cuantos commits se descartaron por tocar demasiados ficheros. */
  readonly discardedByBreadth: number
  /** Cuantos se descartaron por estar en la lista de ignorados. */
  readonly discardedByIgnoreList: number
}

interface Acumulado {
  authorEmail: string
  authorName: string
  lines: number
  commits: number
  lastTouchedAt: Date
}

/**
 * Ownership de los ficheros que aparezcan en `commits`.
 *
 * `paths` acota el resultado a los ficheros que interesan (los que toca una
 * tarea). Sin el, devuelve todos los que aparezcan en la ventana.
 */
export function computeOwnership(
  commits: readonly AuthorshipCommit[],
  paths?: readonly string[],
  options: OwnershipOptions = {},
): OwnershipResult {
  const maxFilesPerCommit = options.maxFilesPerCommit ?? DEFAULT_MAX_FILES_PER_COMMIT
  if (!Number.isInteger(maxFilesPerCommit) || maxFilesPerCommit < 1) {
    throw new ValidationError(
      `maxFilesPerCommit tiene que ser un entero >= 1 y se recibio ${String(maxFilesPerCommit)}.`,
    )
  }

  const interesan = paths === undefined ? undefined : new Set(paths)
  const ignorados = new Set((options.ignoreShas ?? []).map((sha) => sha.trim().toLowerCase()))
  const porFichero = new Map<string, Map<string, Acumulado>>()
  let discardedByBreadth = 0
  let discardedByIgnoreList = 0

  for (const commit of commits) {
    if (ignorados.has(commit.sha.trim().toLowerCase())) {
      discardedByIgnoreList += 1
      continue
    }
    // El tope se mide sobre TODOS los ficheros del commit, no solo sobre los
    // que interesan: un `format all` de 400 ficheros que casualmente toca dos
    // de los nuestros sigue siendo un `format all`.
    if (commit.files.length > maxFilesPerCommit) {
      discardedByBreadth += 1
      continue
    }

    for (const file of commit.files) {
      if (interesan !== undefined && !interesan.has(file.path)) continue
      const autores = porFichero.get(file.path) ?? new Map<string, Acumulado>()
      const previo = autores.get(commit.authorEmail)
      autores.set(commit.authorEmail, {
        authorEmail: commit.authorEmail,
        // Se queda el nombre del commit MAS RECIENTE: si alguien cambio como
        // se firma, lo util es como se firma ahora.
        authorName:
          previo === undefined || commit.at > previo.lastTouchedAt
            ? commit.authorName
            : previo.authorName,
        lines: (previo?.lines ?? 0) + file.lines,
        commits: (previo?.commits ?? 0) + 1,
        lastTouchedAt:
          previo === undefined || commit.at > previo.lastTouchedAt
            ? commit.at
            : previo.lastTouchedAt,
      })
      porFichero.set(file.path, autores)
    }
  }

  const files = [...porFichero.entries()]
    .map(([path, autores]) => toFileOwnership(path, [...autores.values()]))
    .sort((a, b) => a.path.localeCompare(b.path))

  return { files, discardedByBreadth, discardedByIgnoreList }
}

function toFileOwnership(path: string, acumulados: Acumulado[]): FileOwnership {
  const totalLines = acumulados.reduce((suma, a) => suma + a.lines, 0)
  const totalCommits = acumulados.reduce((suma, a) => suma + a.commits, 0)

  const owners = acumulados
    .map((a) => ({
      authorEmail: a.authorEmail,
      authorName: a.authorName,
      lines: a.lines,
      commits: a.commits,
      // Cuando el fichero solo tiene cambios binarios o de modo, `totalLines`
      // es cero y no hay proporcion que repartir. Repartir por commits en ese
      // caso seria inventarse una escala distinta a mitad de la lista.
      share: totalLines === 0 ? 0 : a.lines / totalLines,
      lastTouchedAt: a.lastTouchedAt,
    }))
    .sort(comparaEvidencia)

  return { path, owners, commits: totalCommits }
}

/**
 * Mas lineas primero; a igualdad, mas commits; a igualdad, quien lo toco mas
 * recientemente; y en ultimo lugar el email, alfabeticamente.
 *
 * El desempate final por email no es decoracion: sin el, dos ejecuciones sobre
 * los mismos datos pueden devolver ordenes distintos segun como se construyo el
 * Map, y una sugerencia que cambia sin que cambien los datos no se puede
 * explicar a nadie.
 */
function comparaEvidencia(a: OwnerEvidence, b: OwnerEvidence): number {
  if (a.lines !== b.lines) return b.lines - a.lines
  if (a.commits !== b.commits) return b.commits - a.commits
  const porFecha = b.lastTouchedAt.getTime() - a.lastTouchedAt.getTime()
  if (porFecha !== 0) return porFecha
  return a.authorEmail.localeCompare(b.authorEmail)
}
