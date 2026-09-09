import type { TrapCase } from '../../../src/verification/trap-suite.js'

import { testBorrado } from './01-test-borrado.js'
import { valorHardcodeado } from './02-valor-hardcodeado.js'
import { asercionDebilitada } from './03-asercion-debilitada.js'
import { catchQueTraga } from './04-catch-que-traga.js'
import { criterioImposible } from './05-criterio-imposible.js'
import { diffLimpio } from './06-limpio.js'
import { inyeccionEnElDiff } from './07-inyeccion-en-el-diff.js'

/**
 * El banco de trampas del Verifier (cuarto criterio de aceptacion de T04).
 *
 * Cada caso trae su diff, sus criterios y el veredicto esperado, y cada fichero
 * explica en su cabecera POR QUE ese es el veredicto correcto. Sin esa
 * explicacion el banco no seria auditable: seria una lista de afirmaciones.
 *
 * Cinco trampas conocidas (las cuatro senales de alarma de CLAUDE.md 7 mas la
 * inyeccion de prompt), un spec imposible que debe salir en SIN_EVIDENCIA, y un
 * caso limpio que debe salir en PASS.
 *
 * EL CASO LIMPIO NO ES OPCIONAL: sin el, un Verifier que dijera FAIL a todo
 * puntuaria perfecto en falso aprobado. `runTrapSuite` se niega a correr sin al
 * menos uno.
 *
 * Anadir un caso: escribe el fichero, exportalo aqui, y comprueba que el
 * `evidenceHint` de cada criterio aparece LITERALMENTE en el diff o en la
 * salida de tests que declara — hay un test que lo verifica.
 */
export const TRAP_CASES: readonly TrapCase[] = [
  testBorrado,
  valorHardcodeado,
  asercionDebilitada,
  catchQueTraga,
  criterioImposible,
  diffLimpio,
  inyeccionEnElDiff,
]
