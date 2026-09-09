/**
 * `@coord/agents` — los agentes del epic 05 (verificacion por resultados) y el
 * unico paquete que conoce a un proveedor de LLM.
 *
 * Contiene:
 *
 *   * `anthropic.ts` — el adaptador de `LlmPort`
 *     (`packages/core/src/ports/llm.ts`) sobre `@anthropic-ai/sdk`. Es la ruta
 *     de PRODUCCION: el PRD §5 manda las llamadas de la plataforma (router y
 *     Verifier) por API de pago por token.
 *   * `claude-cli.ts` — el mismo `LlmPort` sobre el CLI de Claude Code, para
 *     MEDIR sobre una suscripcion ya pagada. NO es la ruta de produccion: su
 *     aislamiento es una lista negra de herramientas y no una propiedad del
 *     transporte. Lee su cabecera antes de usarlo.
 *   * `verification/test-generator.ts` — T02: los tests los escribe un agente
 *     distinto al que implementa, a partir de los criterios y NUNCA del codigo.
 *   * `verification/test-manifest.ts` — T02: manifiesto firmado del arbol de
 *     tests generados, y la deteccion determinista de manipulacion.
 *   * `verification/generated-tests-fs.ts` — la E/S de ese manifiesto.
 *   * `verification/tamper-audit.ts` — el registro del intento en `audit_log`.
 *   * `verification/verifier.ts` — T04: el Verifier en contexto aislado. Recibe
 *     criterios, diff y salida de tests, y NADA MAS: el aislamiento es una
 *     propiedad del tipo `VerificationInput`, no una promesa del prompt.
 *   * `verification/trap-suite.ts` — T04: el banco de diffs con trampas
 *     conocidas y el calculo de las tasas de falso aprobado y falso rechazo.
 *     Es el INSTRUMENTO; la medida contra el modelo real NO esta hecha.
 *   * `verification/report.ts` — T05: la estructura del informe de conformidad
 *     y el veredicto global binario (apto/no apto), derivado de los veredictos
 *     de T04 sin perder ni un campo.
 *   * `verification/report-render.ts` — T05: los dos renderizados (Markdown y
 *     texto plano) desde la misma estructura, con el presupuesto de "cabe en
 *     una pantalla" expresado en lineas y caracteres, medido y truncado por lo
 *     que menos importa (los PASS se resumen; los FAIL y SIN_EVIDENCIA nunca).
 *   * `verification/report-publisher.ts` — T05: publica el Markdown como
 *     comentario de PR reutilizando `@coord/github` (`publishPullRequestComment`).
 *     NO se ha publicado nunca contra GitHub de verdad: no hay una GitHub App
 *     registrada. Ver la cabecera de ese fichero.
 *
 * La fitness function `anthropic-sdk-solo-en-agents` (ver
 * `.dependency-cruiser.cjs`) impide importar el SDK desde cualquier otro
 * paquete: fuera de aqui, quien necesite un modelo pide un `LlmPort`.
 *
 * OJO: el adaptador esta escrito y tipado pero NO se ha ejercitado contra la
 * API de Anthropic de verdad (no hay credenciales en la maquina donde se
 * escribio). Ver la cabecera de `anthropic.ts`. El generador de T02 hereda esa
 * misma advertencia: sus tests corren contra un doble HTTP local.
 *
 * `verification/verify-generated-tests-cli.ts` NO se reexporta aqui: es un
 * ejecutable, y exportarlo haria que importar el paquete corriese la
 * comprobacion y llamase a `process.exit`.
 */
export * from './anthropic.js'
export * from './claude-cli.js'
export * from './verification/test-manifest.js'
export * from './verification/test-generator.js'
export * from './verification/generated-tests-fs.js'
export * from './verification/tamper-audit.js'
export * from './verification/verifier.js'
export * from './verification/trap-suite.js'
export * from './verification/report.js'
export * from './verification/report-render.js'
export * from './verification/report-publisher.js'
