import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Minado de `git log` para el overlay de co-cambio. `node:child_process`,
 * CERO dependencias nuevas — mismo motivo y mismas precauciones que
 * `ingest/git.ts`: `execFile` con argumentos en array (nunca `exec` con una
 * cadena) y `-C <ruta>` en vez de tocar el `cwd` del proceso.
 */
const run = promisify(execFile)

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024

/** Separadores que no pueden aparecer en un sha ni en una ruta de git. */
const SHA_MARK = '\x01'
const AFTER_SHA_MARK = '\x02'

export interface CommitFileList {
  readonly sha: string
  readonly files: readonly string[]
}

export interface ListCochangeCommitsOptions {
  /** Ventana de historial: solo commits de los ultimos N meses. Ver `mine.ts` por que. */
  readonly sinceMonths: number
}

/**
 * Un commit por entrada, con los ficheros que TOCO (no los que ya existian).
 *
 * ---------------------------------------------------------------------------
 * RENOMBRADOS: `--no-renames`, A PROPOSITO
 * ---------------------------------------------------------------------------
 * Se pasa `--no-renames` de forma EXPLICITA para que el resultado no dependa
 * de `diff.renames` en el `.gitconfig` de quien ejecute la ingesta — con
 * deteccion de renombrados activada, un `git mv grande.ts a/grande.ts` se
 * reportaria como una sola linea `R100` en vez de un borrado y un alta, y el
 * parseo cambiaria de forma segun la maquina. Con `--no-renames`, un fichero
 * renombrado es DOS identidades de ruta distintas: su historial de co-cambio
 * ANTES del renombrado se pierde con el nombre antiguo.
 *
 * Es una simplificacion consciente. Seguirlo de verdad exigiria `--follow`,
 * que solo sigue UN fichero cada vez: minar co-cambios de un repo entero
 * ejecutando `git log --follow` fichero por fichero no escala (séria un
 * proceso de git por fichero indexado, no una sola pasada). El coste de
 * resolverlo bien no esta justificado por el caso de uso real de este equipo
 * (renombrados ocasionales, no reorganizaciones masivas constantes). Si algun
 * dia hace falta, el disparador es medible: aristas de co-change que se cortan
 * visiblemente en el commit de un renombrado grande.
 *
 * ---------------------------------------------------------------------------
 * VENTANA DE HISTORIAL: una ventana de TIEMPO, NO "ultimos N commits"
 * ---------------------------------------------------------------------------
 * Se eligio una ventana de TIEMPO sobre un conteo de commits
 * porque la cadencia de commits varia muchisimo entre repos y entre equipos:
 * "los ultimos 500 commits" son dos semanas en un repo con mucho trafico y
 * varios anos en uno tranquilo, asi que como senal de "que esta acoplado
 * AHORA" un conteo fijo no es comparable entre repos. Una ventana de tiempo si
 * lo es. Configurable en meses; el valor por defecto vive en `mine.ts`.
 */
export async function listCochangeCommits(
  repoPath: string,
  options: ListCochangeCommitsOptions,
): Promise<CommitFileList[]> {
  const { stdout } = await run(
    'git',
    [
      '-C',
      repoPath,
      // `core.quotepath=false` de forma EXPLICITA. Por defecto git ESCAPA los
      // caracteres no ASCII de las rutas ("src/a\303\261o.ts" en vez de
      // "src/año.ts"), y esas rutas no casarian nunca con las de `graph_nodes`:
      // el par se descartaria en silencio y solo se veria como un incremento de
      // `unresolvedPairs`, sin explicacion. Igual que `--no-renames`, se fija
      // aqui para no depender del `.gitconfig` de quien ejecute la ingesta.
      '-c',
      'core.quotepath=false',
      'log',
      '--no-renames',
      '--name-only',
      // `--since-as-filter`, NO `--since`. MEDIDO, no supuesto: `--since` PARA
      // DE RECORRER en cuanto encuentra un commit mas viejo que el corte, en
      // vez de filtrar. Un solo commit con la fecha desviada en la punta —un
      // rebase, un `git commit --date`, un reloj mal puesto, historial
      // importado de otro VCS, un `git filter-repo`— vacia la ventana ENTERA
      // sin un solo error. Comprobado con git 2.43 sobre un repo de tres
      // commits, el ultimo fechado dos años atras: `--since=12 months ago`
      // devolvio CERO commits y `--since-as-filter=12 months ago` devolvio los
      // dos recientes. Cero, no "menos".
      //
      // El sintoma habria sido "el overlay de co-cambio no produce nada" o
      // "produce muchisimo menos de lo que deberia", sin nada que lo explique:
      // los pares no aparecerian, y `unresolvedPairs` tampoco subiria, porque
      // no es que no se resuelvan, es que no llegan a existir.
      //
      // Existe desde git 2.37 (2022). Si alguien corre uno anterior, git falla
      // en voz alta con "unknown option", que es infinitamente mejor que
      // devolver una lista vacia y que nadie se entere.
      `--since-as-filter=${String(options.sinceMonths)} months ago`,
      `--pretty=format:${SHA_MARK}%H${AFTER_SHA_MARK}`,
    ],
    { maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
  )
  return parseNameOnlyLog(stdout)
}

/**
 * Exportada para poder probar el parseo sin depender de que `git log` este
 * disponible en el entorno del test unitario — el test de integracion contra
 * un repositorio real (`git init` de verdad) vive en `cochange.test.ts` y
 * ejercita esta funcion entera, no solo el parseo.
 */
export function parseNameOnlyLog(stdout: string): CommitFileList[] {
  const commits: CommitFileList[] = []
  // El primer trozo (antes del primer SHA_MARK) esta vacio si `stdout`
  // arranca con el marcador, que es siempre el caso salvo historial vacio.
  for (const chunk of stdout.split(SHA_MARK)) {
    if (chunk === '') continue
    const markerEnd = chunk.indexOf(AFTER_SHA_MARK)
    if (markerEnd === -1) continue
    const sha = chunk.slice(0, markerEnd)
    const files = chunk
      .slice(markerEnd + 1)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    commits.push({ sha, files })
  }
  return commits
}
