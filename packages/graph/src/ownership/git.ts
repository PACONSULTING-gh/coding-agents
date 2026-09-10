import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Lectura de `git log` para la señal de OWNERSHIP (epic 03 / T01).
 *
 * Mismas precauciones que `cochange/git.ts`, y por los mismos motivos: `execFile`
 * con argumentos en array (nunca `exec` con una cadena), `-C <ruta>` en vez de
 * tocar el `cwd` del proceso, `core.quotepath=false` para que las rutas con
 * acentos no salgan escapadas, y `--no-renames` explicito para no depender del
 * `.gitconfig` de quien ejecute esto.
 *
 * ===========================================================================
 * POR QUE `--numstat` Y NO `--name-only`
 * ===========================================================================
 * El criterio de aceptacion de T01 dice, literalmente, "ordenadas por evidencia
 * real de autoria, NO por numero bruto de commits". Contar commits por fichero
 * seria justo eso con otro nombre: quien cambio una linea y quien escribio el
 * fichero entero valdrian lo mismo.
 *
 * `--numstat` trae las lineas añadidas y borradas POR FICHERO en la misma
 * pasada, sin un proceso de git mas. Con eso el ranking se puede hacer por
 * volumen de cambio y el numero de commits queda como desempate y como dato
 * citable en el shortlist ("12 commits, 430 lineas").
 *
 * Los ficheros binarios salen como `-\t-\t<ruta>`: cuentan como commit pero con
 * cero lineas, que es lo unico honesto que se puede decir de ellos.
 *
 * ===========================================================================
 * `--no-merges`
 * ===========================================================================
 * La lista de ficheros de un merge no la escribio nadie: es el resultado de
 * juntar dos ramas. Atribuirsela a quien pulso el boton de merge convertiria al
 * que integra en dueño de todo lo que integra.
 */
const run = promisify(execFile)

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024

/** Separadores que no pueden aparecer en un sha, un ident de git ni una ruta. */
const COMMIT_MARK = '\x01'
const FIELD_MARK = '\x02'

export interface FileChange {
  readonly path: string
  /** Lineas añadidas + borradas. Cero en binarios y en cambios de solo modo. */
  readonly lines: number
}

export interface AuthorshipCommit {
  readonly sha: string
  /**
   * Identidad estable del autor: el email en minusculas. El nombre cambia
   * ("Javier", "javier viseras", "JVISERASS") y agruparia a la misma persona
   * en tres; el email aguanta mejor.
   */
  readonly authorEmail: string
  /** Para enseñarselo a un humano. No se usa para agrupar. */
  readonly authorName: string
  readonly at: Date
  readonly files: readonly FileChange[]
}

export interface ListAuthorshipOptions {
  /**
   * Ventana de historial en meses. Misma decision que el minado de co-cambio
   * (`cochange/git.ts`): una ventana de TIEMPO y no "los ultimos N commits",
   * porque la cadencia varia muchisimo entre repos y un conteo fijo no es
   * comparable.
   *
   * Es tambien toda la "recencia" que tiene esta señal, y a proposito: un
   * decaimiento exponencial haria que quien arreglo una errata la semana
   * pasada adelantase a quien diseño el fichero hace ocho meses, que es
   * exactamente el fallo que el criterio de aceptacion quiere evitar. Un corte
   * responde a "quien trabaja en esto AHORA" sin ese efecto. Si algun dia hace
   * falta ordenar por antiguedad DENTRO de la ventana, se añade con datos del
   * piloto para calibrar la semivida, no antes.
   */
  readonly sinceMonths: number
}

/**
 * Un commit por entrada, con su autor y los ficheros que toco.
 *
 * NO filtra nada: los commits mecanicos (un `format all` de 400 ficheros) se
 * descartan despues, en `score.ts`, para que el filtro se pueda probar sin
 * ejecutar git.
 */
export async function listAuthorshipCommits(
  repoPath: string,
  options: ListAuthorshipOptions,
): Promise<AuthorshipCommit[]> {
  const { stdout } = await run(
    'git',
    [
      '-C',
      repoPath,
      '-c',
      'core.quotepath=false',
      'log',
      '--no-renames',
      '--no-merges',
      '--numstat',
      // `--since-as-filter`, NO `--since`. MEDIDO, no supuesto: `--since` PARA
      // DE RECORRER en cuanto encuentra un commit mas viejo que el corte, en
      // vez de filtrar. Un solo commit con la fecha desviada en la punta —un
      // rebase, un `git commit --date`, un reloj mal puesto, historial
      // importado— vacia la ventana ENTERA sin un solo error. Comprobado con
      // git 2.43 sobre un repo de tres commits, el ultimo fechado dos años
      // atras: `--since=12 months ago` devolvio CERO commits y
      // `--since-as-filter=12 months ago` devolvio los dos recientes.
      //
      // Existe desde git 2.37 (2022). Si alguien corre uno anterior, git falla
      // en voz alta con "unknown option", que es infinitamente mejor que
      // devolver una lista vacia y que nadie se entere de que la señal de
      // ownership no existe.
      `--since-as-filter=${String(options.sinceMonths)} months ago`,
      `--pretty=format:${COMMIT_MARK}%H${FIELD_MARK}%ae${FIELD_MARK}%an${FIELD_MARK}%aI${FIELD_MARK}`,
    ],
    { maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
  )
  return parseNumstatLog(stdout)
}

/**
 * Exportada para poder probar el parseo sin depender de que `git` exista en el
 * entorno del test unitario. El test contra un repositorio de verdad vive en
 * `ownership.test.ts` y ejercita la funcion entera.
 */
export function parseNumstatLog(stdout: string): AuthorshipCommit[] {
  const commits: AuthorshipCommit[] = []
  for (const chunk of stdout.split(COMMIT_MARK)) {
    if (chunk === '') continue
    const [sha, authorEmail, authorName, isoDate, resto] = chunk.split(FIELD_MARK)
    if (
      sha === undefined ||
      authorEmail === undefined ||
      authorName === undefined ||
      isoDate === undefined
    ) {
      continue
    }
    const at = new Date(isoDate)
    if (Number.isNaN(at.getTime())) continue

    const files = (resto ?? '')
      .split('\n')
      .map((line) => parseNumstatLine(line))
      .filter((file): file is FileChange => file !== undefined)

    commits.push({
      sha,
      authorEmail: authorEmail.trim().toLowerCase(),
      authorName: authorName.trim(),
      at,
      files,
    })
  }
  return commits
}

/** `<añadidas>\t<borradas>\t<ruta>`, o `-\t-\t<ruta>` en binarios. */
function parseNumstatLine(line: string): FileChange | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  const parts = trimmed.split('\t')
  if (parts.length < 3) return undefined
  const [added, deleted, ...pathParts] = parts
  const path = pathParts.join('\t')
  if (path === '') return undefined
  return { path, lines: toCount(added) + toCount(deleted) }
}

/** `-` significa binario: cero lineas, no un fallo de parseo. */
function toCount(value: string | undefined): number {
  if (value === undefined || value === '-') return 0
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}
