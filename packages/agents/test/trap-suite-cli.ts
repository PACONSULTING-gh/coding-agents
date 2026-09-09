/**
 * Mide la tasa de falso aprobado del Verifier contra el modelo DE VERDAD.
 *
 *     ANTHROPIC_API_KEY=... pnpm --filter @coord/agents measure:trap-suite
 *
 * ===========================================================================
 * ESTE COMANDO NO SE HA EJECUTADO NUNCA
 * ===========================================================================
 * En la maquina donde se escribio T04 no hay credenciales de Anthropic, asi que
 * el banco solo se ha corrido contra el doble HTTP local — que comprueba el
 * INSTRUMENTO y no dice nada sobre el Verifier. La tasa de falso aprobado que
 * pide el cuarto criterio de aceptacion de T04 ESTA SIN MEDIR, y el criterio
 * queda pendiente hasta que alguien corra esto y pegue la salida.
 *
 * Cuesta dinero: son siete llamadas a `claude-opus-5` con esfuerzo `xhigh`
 * sobre diffs enteros. Por eso es un comando explicito y no un test: un banco
 * que se dispara solo en cada CI seria una factura recurrente por una cifra que
 * apenas se mueve.
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
import { AnthropicLlm } from '../src/anthropic.js'
import { formatTrapSuiteReport, runTrapSuite } from '../src/verification/trap-suite.js'

import { TRAP_CASES } from './fixtures/trampas/index.js'

const API_KEY_ENV = 'ANTHROPIC_API_KEY'

async function main(): Promise<void> {
  const apiKey = process.env[API_KEY_ENV]
  if (apiKey === undefined || apiKey.trim() === '') {
    // Falla ruidosamente y sin alternativa. No hay modo "sin clave" a
    // proposito: un banco que se degrada a un doble cuando falta la
    // credencial acabaria imprimiendo una tasa que parece medida y no lo esta,
    // que es exactamente lo que este epic existe para evitar.
    process.stderr.write(
      `Falta ${API_KEY_ENV}. Este comando mide contra el modelo de verdad y no tiene modo ` +
        'degradado: sin clave no hay medicion, y una tasa inventada es peor que ninguna.\n',
    )
    process.exit(2)
  }

  const llm = new AnthropicLlm({ apiKey })

  process.stderr.write(
    `Midiendo ${String(TRAP_CASES.length)} casos contra la API de Anthropic. ` +
      'Esto gasta tokens de verdad.\n',
  )

  // Sin try/catch: si una llamada falla, el error sube con su tipo y el proceso
  // muere. Una medicion a medias no se presenta como una medicion.
  const report = await runTrapSuite(llm, TRAP_CASES)

  process.stdout.write(`${formatTrapSuiteReport(report)}\n`)

  // Codigo de salida 1 si el Verifier aprobo alguna trampa. Es el unico
  // resultado que descalifica el modulo entero: significa que se puede colar
  // trabajo tramposo por el gate.
  process.exit(report.falseApprovals > 0 ? 1 : 0)
}

await main()
