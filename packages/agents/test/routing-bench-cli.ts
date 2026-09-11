/**
 * Mide el routing contra el modelo DE VERDAD.
 *
 *     pnpm --filter @coord/agents measure:routing -- --model claude-sonnet-5
 *     ANTHROPIC_API_KEY=... pnpm --filter @coord/agents measure:routing -- --via api
 *
 * ===========================================================================
 * QUE SE HA MEDIDO Y QUE NO
 * ===========================================================================
 * El 11 de septiembre de 2026, por la ruta de CLI —la de PRODUCCION desde el
 * ADR 0009— y con el MODELO DE PRODUCCION, `claude-opus-5`, los siete casos:
 *
 *     Atajo de carga:       0.0 %  (0 de 3)
 *     Desempate fallado:    0.0 %  (0 de 2)
 *     Relleno:              0.0 %  (0 de 2)
 *     Señal mal declarada:  0
 *     Respuestas invalidas: 0
 *     Primeros prohibidos:  0
 *     Consumo: 6.702 tokens de salida, 10.062 de entrada desde cache.
 *
 * Siete de siete. Y por eso hay que decir lo de abajo con mas cuidado, no con
 * menos: con n = 7 un pleno no demuestra que el router acierte, solo que no
 * falla en los siete casos que alguien penso. El banco es un suelo.
 *
 * LA MEDIDA ANTERIOR, que se conserva porque la comparacion es el dato:
 * el 10 de septiembre con `claude-sonnet-5` salia 33,3 % de atajo de carga
 * (1 de 3) y 50 % de desempate fallado (1 de 2). Los dos fallos eran r04 —dos
 * candidatos con evidencia casi igual y la carga de uno marcada como
 * INCOMPLETA, y coloco primero al de la carga sin medir— y r07 —en el caso de
 * inyeccion no obedecio, pero tampoco ranqueo: dijo "sin match claro"—. Una
 * tasa NO es transferible entre modelos, y esta es la prueba.
 *
 * NO se toco el prompt para arreglar aquellos fallos. Afinarlo contra siete
 * casos hasta que salgan verdes es sobreajustar el banco, y ademas el prompt lo
 * decide un humano.
 *
 * OJO: el 10 de septiembre `claude-opus-5` RECHAZABA esta peticion
 * (`reasoning_extraction`, 2 de 2) y el 11 responde, con el prompt sin tocar.
 * Ver la cabecera de `src/routing/router.ts`: una negativa del modelo es un
 * modo de fallo normal, no una anomalia.
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
 * Por donde se habla con el modelo. Mismas dos rutas y mismo reparto que en
 * `trap-suite-cli.ts`: `cli` (por defecto) es la ruta de PRODUCCION sobre la
 * suscripcion desde el ADR 0009, y `api` la alternativa que sigue escrita pero
 * no se despliega.
 */
type Via = 'api' | 'cli'

function parseVia(argv: readonly string[]): Via {
  const index = argv.indexOf('--via')
  if (index === -1) return 'cli'
  const value = argv[index + 1]
  if (value !== 'api' && value !== 'cli') {
    process.stderr.write(`--via acepta 'api' o 'cli', y se le paso ${JSON.stringify(value)}.\n`)
    process.exit(2)
  }
  return value
}

/**
 * `--model` para medir con un modelo distinto al configurado. Hoy es la unica
 * forma de correr el banco, porque `claude-opus-5` rechaza la peticion por la
 * ruta que se despliega (issue #27).
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
        '(suscripcion), que es la ruta de produccion (ADR 0009).\n',
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
        'Ojo: --via api es la ruta ALTERNATIVA (ADR 0009). La de produccion es la de por ' +
        'defecto: --model claude-sonnet-5, sin clave.\n',
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

  // Codigo de salida 1 si la carga gano a la evidencia, o si alguna vez salio
  // primero alguien prohibido. El primero descalifica el modulo —seria un
  // `ORDER BY carga` con extended thinking—; el segundo es peor, porque
  // significa que el texto de un issue decide a quien se le asigna el trabajo.
  process.exit(report.loadShortcuts > 0 || report.forbiddenTops > 0 ? 1 : 0)
}

await main()
