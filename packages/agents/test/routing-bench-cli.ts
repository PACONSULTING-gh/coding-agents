/**
 * Mide el routing contra el modelo DE VERDAD.
 *
 *     ANTHROPIC_API_KEY=... pnpm --filter @coord/agents measure:routing
 *     pnpm --filter @coord/agents measure:routing -- --via cli --model claude-sonnet-5
 *
 * ===========================================================================
 * QUE SE HA MEDIDO Y QUE NO
 * ===========================================================================
 * Por la ruta de API: NADA. No hay credenciales en esta maquina.
 *
 * Por la ruta del CLI, y solo con una sonda manual de un caso (no este banco):
 * `claude-opus-5` RECHAZA la peticion del router con la categoria
 * `reasoning_extraction`, igual que la del Verifier; `claude-sonnet-5` responde
 * y ranquea la evidencia por encima de la carga. Ese dato esta en el issue #27.
 * NO es la cifra que pide el criterio de aceptacion: un caso no es una tasa.
 *
 * Mismo argumento que el banco de trampas: es un comando explicito y no un
 * test, porque siete llamadas con esfuerzo `xhigh` en cada CI serian una
 * factura recurrente por una cifra que apenas se mueve.
 *
 * ---------------------------------------------------------------------------
 * POR QUE VIVE EN `test/` Y NO EN `src/`
 * ---------------------------------------------------------------------------
 * Los casos son fixtures (`test/fixtures/routing/`) y las dependencias apuntan
 * hacia dentro: `src/` no puede importar de `test/`. La maquinaria reutilizable
 * —`runRoutingBench`, `formatRoutingBenchReport`— si esta en
 * `src/routing/bench.ts`. Aqui solo queda el arranque.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LlmPort } from '@coord/core'

import { AnthropicLlm } from '../src/anthropic.js'
import { ClaudeCliLlm } from '../src/claude-cli.js'
import { formatRoutingBenchReport, runRoutingBench } from '../src/routing/bench.js'

import { ROUTING_BENCH_CASES } from './fixtures/routing/index.js'

const API_KEY_ENV = 'ANTHROPIC_API_KEY'

/**
 * Por donde se habla con el modelo. Mismas dos rutas y mismas advertencias que
 * en `trap-suite-cli.ts`: `api` es produccion, `cli` es una ruta de MEDICION
 * sobre una suscripcion ya pagada, y lo que salga por ahi hay que citarlo asi.
 */
type Via = 'api' | 'cli'

function parseVia(argv: readonly string[]): Via {
  const index = argv.indexOf('--via')
  if (index === -1) return 'api'
  const value = argv[index + 1]
  if (value !== 'api' && value !== 'cli') {
    process.stderr.write(`--via acepta 'api' o 'cli', y se le paso ${JSON.stringify(value)}.\n`)
    process.exit(2)
  }
  return value
}

/**
 * `--model` para medir con un modelo distinto al de produccion. Hoy es la unica
 * forma de correr el banco por la ruta de suscripcion, porque `claude-opus-5`
 * rechaza la peticion por ahi (issue #27).
 *
 * Una tasa no es transferible entre modelos: medir Sonnet y presentarlo como la
 * cifra de Opus seria justo el numero inventado que este proyecto persigue.
 */
function parseModel(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--model')
  return index === -1 ? undefined : argv[index + 1]
}

async function buildLlm(via: Via): Promise<LlmPort> {
  if (via === 'cli') {
    // Directorio vacio: si alguna herramienta se escapara de la lista negra, no
    // hay nada que leer. Ver la cabecera de `claude-cli.ts`.
    const cwd = await mkdtemp(join(tmpdir(), 'routing-bench-'))
    process.stderr.write(
      `Midiendo ${String(ROUTING_BENCH_CASES.length)} casos con el CLI de Claude Code ` +
        '(suscripcion). AVISO: no es la ruta de produccion; cita la cifra como medida por CLI.\n',
    )
    return new ClaudeCliLlm({ cwd })
  }

  const apiKey = process.env[API_KEY_ENV]
  if (apiKey === undefined || apiKey.trim() === '') {
    // Sin modo degradado, a proposito: un banco que se cae a un doble cuando
    // falta la credencial imprimiria una tasa que parece medida y no lo esta.
    process.stderr.write(
      `Falta ${API_KEY_ENV}. Este comando mide contra el modelo de verdad y no tiene modo ` +
        'degradado: sin clave no hay medicion, y una tasa inventada es peor que ninguna. ' +
        'Alternativa sobre una suscripcion ya pagada: --via cli --model claude-sonnet-5.\n',
    )
    process.exit(2)
  }

  process.stderr.write(
    `Midiendo ${String(ROUTING_BENCH_CASES.length)} casos contra la API de Anthropic. ` +
      'Esto gasta tokens de verdad.\n',
  )
  return new AnthropicLlm({ apiKey })
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const llm = await buildLlm(parseVia(argv))
  const model = parseModel(argv)
  if (model !== undefined) {
    process.stderr.write(`Modelo forzado: ${model}. Cita la cifra nombrando este modelo.\n`)
  }

  // Sin try/catch: si el modelo se niega o una respuesta no valida, el error
  // sube con su tipo y el proceso muere. Una medicion a medias no se presenta
  // como una medicion.
  const report = await runRoutingBench(
    llm,
    ROUTING_BENCH_CASES,
    model === undefined ? {} : { model },
  )

  process.stdout.write(`${formatRoutingBenchReport(report)}\n`)

  // Codigo de salida 1 si la carga gano a la evidencia alguna vez. Es el
  // resultado que descalifica el modulo entero: significa que el router es un
  // `ORDER BY carga` con extended thinking.
  process.exit(report.loadShortcuts > 0 ? 1 : 0)
}

await main()
