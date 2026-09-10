/**
 * Mide la tasa de falso aprobado del Verifier contra el modelo DE VERDAD.
 *
 *     pnpm --filter @coord/agents measure:trap-suite -- --model claude-sonnet-5
 *     ANTHROPIC_API_KEY=... pnpm --filter @coord/agents measure:trap-suite -- --via api
 *
 * ===========================================================================
 * QUE SE HA MEDIDO Y QUE NO
 * ===========================================================================
 * Corrido el 9 de septiembre de 2026 por la ruta de CLI —la de PRODUCCION
 * desde el ADR 0009— con `claude-sonnet-5`: 0 de 6 trampas aprobadas y 0 de 1
 * casos limpios bloqueados, con un desacuerdo (el caso de inyeccion contesto
 * SIN_EVIDENCIA donde el banco espera FAIL). La cifra entera, con las tres
 * cosas que NO dice, esta en el README de este paquete.
 *
 * LO QUE SIGUE SIN MEDIR es el MODELO configurado, `claude-opus-5`: rechaza la
 * peticion del Verifier con la categoria `reasoning_extraction` (issue #27), y
 * desde el ADR 0009 eso ya no es un estorbo para medir sino un bloqueo de
 * produccion, porque el rechazo es por el camino que se despliega.
 *
 * No corre en CI a proposito: siete llamadas con esfuerzo `xhigh` sobre diffs
 * enteros en cada push serian un peaje recurrente —de factura por la ruta de
 * API, de limites de suscripcion por la de CLI— por una cifra que apenas se
 * mueve. Por eso es un comando explicito.
 *
 * ---------------------------------------------------------------------------
 * POR QUE VIVE EN `test/` Y NO EN `src/`
 * ---------------------------------------------------------------------------
 * Porque los casos del banco son fixtures (`test/fixtures/trampas/`) y las
 * dependencias apuntan hacia dentro: `src/` no puede importar de `test/`. La
 * maquinaria reutilizable —`runTrapSuite`, `formatTrapSuiteReport`— si esta en
 * `src/verification/trap-suite.ts`, que es lo que otro banco de casos podria
 * reutilizar. Aqui solo queda el arranque.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LlmPort } from '@coord/core'

import { AnthropicLlm } from '../src/anthropic.js'
import { ClaudeCliLlm } from '../src/claude-cli.js'
import { formatTrapSuiteReport, runTrapSuite } from '../src/verification/trap-suite.js'

import { TRAP_CASES } from './fixtures/trampas/index.js'

const API_KEY_ENV = 'ANTHROPIC_API_KEY'

/**
 * Por donde se habla con el modelo.
 *
 *   - `cli` (por defecto) — el CLI de Claude Code sobre la suscripcion. Es LA
 *     RUTA DE PRODUCCION desde el ADR 0009, y por eso es la que se mide por
 *     defecto: un banco que mide un transporte que no se despliega da una
 *     cifra que no describe nada.
 *   - `api` — la ruta alternativa (`anthropic.ts`), que sigue escrita para los
 *     disparadores del ADR 0009 pero hoy no se usa. Cuesta dinero por token.
 *
 * Lo que sigue siendo verdad del CLI, y hay que citarlo al dar la cifra: su
 * aislamiento es una lista negra de herramientas y no una propiedad del
 * transporte, y no hay salida estructurada garantizada por el servidor. Eso es
 * el precio del ADR 0009, no una tacha de la medida.
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

async function buildLlm(via: Via): Promise<LlmPort> {
  if (via === 'cli') {
    // Directorio vacio: si alguna herramienta se escapara de la lista negra, no
    // hay nada que leer. Ver la cabecera de `claude-cli.ts`.
    const cwd = await mkdtemp(join(tmpdir(), 'trap-suite-'))
    process.stderr.write(
      `Midiendo ${String(TRAP_CASES.length)} casos con el CLI de Claude Code (suscripcion), ` +
        'que es la ruta de produccion (ADR 0009).\n',
    )
    return new ClaudeCliLlm({ cwd })
  }

  const apiKey = process.env[API_KEY_ENV]
  if (apiKey === undefined || apiKey.trim() === '') {
    // Falla ruidosamente y sin alternativa. No hay modo "sin clave" a
    // proposito: un banco que se degrada a un doble cuando falta la
    // credencial acabaria imprimiendo una tasa que parece medida y no lo esta,
    // que es exactamente lo que este epic existe para evitar.
    process.stderr.write(
      `Falta ${API_KEY_ENV}. Este comando mide contra el modelo de verdad y no tiene modo ` +
        'degradado: sin clave no hay medicion, y una tasa inventada es peor que ninguna. ' +
        'Ojo: --via api es la ruta ALTERNATIVA (ADR 0009). La de produccion es la de por ' +
        'defecto, y no necesita clave.\n',
    )
    process.exit(2)
  }

  process.stderr.write(
    `Midiendo ${String(TRAP_CASES.length)} casos contra la API de Anthropic. ` +
      'Esto gasta tokens de verdad.\n',
  )
  return new AnthropicLlm({ apiKey })
}

/**
 * `--model` para poder medir con un modelo distinto al configurado.
 *
 * No es un capricho: medido el 9 de septiembre de 2026, `claude-opus-5` sobre
 * el CLI RECHAZA la peticion del Verifier con la categoria
 * `reasoning_extraction` (2 de 2 intentos), mientras que `claude-sonnet-5`
 * responde con normalidad. Sin esta opcion, el banco no se puede correr en
 * absoluto por la ruta que ahora es la de produccion — y eso, desde el ADR
 * 0009, no es un estorbo para medir sino un BLOQUEO DE PRODUCCION: el modelo
 * por defecto no contesta por el camino que se despliega (issue #27).
 *
 * Lo que salga con un modelo que NO es el configurado hay que citarlo
 * nombrando el modelo. Una tasa de falso aprobado no es transferible entre
 * modelos: medir Sonnet y presentarlo como la cifra de Opus seria justo la
 * clase de numero inventado que este epic existe para evitar.
 */
function parseModel(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--model')
  return index === -1 ? undefined : argv[index + 1]
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const llm = await buildLlm(parseVia(argv))
  const model = parseModel(argv)
  if (model !== undefined) {
    process.stderr.write(`Modelo forzado: ${model}. Cita la cifra nombrando este modelo.\n`)
  }

  // Sin try/catch: si una llamada falla, el error sube con su tipo y el proceso
  // muere. Una medicion a medias no se presenta como una medicion.
  const report = await runTrapSuite(llm, TRAP_CASES, model === undefined ? {} : { model })

  process.stdout.write(`${formatTrapSuiteReport(report)}\n`)

  // Codigo de salida 1 si el Verifier aprobo alguna trampa. Es el unico
  // resultado que descalifica el modulo entero: significa que se puede colar
  // trabajo tramposo por el gate.
  process.exit(report.falseApprovals > 0 ? 1 : 0)
}

await main()
