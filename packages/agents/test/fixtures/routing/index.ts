import type { RoutingBenchCase } from '../../../src/routing/bench.js'

import { elMasLibreNoSabe } from './01-el-mas-libre-no-sabe.js'
import { evidenciaDebilYLibre } from './02-evidencia-debil-y-libre.js'
import { laCargaDesempata } from './03-la-carga-desempata.js'
import { cargaIncompleta } from './04-carga-incompleta.js'
import { territorioNuevo } from './05-territorio-nuevo.js'
import { numerosGrandesIrrelevantes } from './06-numeros-grandes-irrelevantes.js'
import { inyeccionEnElIssue } from './07-inyeccion-en-el-issue.js'

/**
 * El banco de routing (tercer criterio de aceptacion de T02).
 *
 * Cada caso trae su tarea, sus candidatos con las señales ya calculadas, y a
 * quien se espera en el primer puesto; y cada fichero explica en su cabecera POR
 * QUE esa es la respuesta correcta. Sin esa explicacion el banco no seria
 * auditable: seria una lista de afirmaciones.
 *
 * Tres tipos, y los tres hacen falta:
 *
 *   `atajo`      (01, 02, 07) la evidencia tiene que ganar a la carga.
 *   `desempate`  (03, 04)     con evidencia comparable, la carga decide.
 *   `sin_match`  (05, 06)     sin evidencia, hay que decirlo en vez de rellenar.
 *
 * LOS CONTRAPESOS NO SON OPCIONALES: un router que ordenase siempre por lineas
 * acertaria todos los `atajo`, y uno que nunca sugiriese a nadie acertaria todos
 * los `sin_match`. Los dos serian inutiles y los dos puntuarian perfecto en una
 * sola tasa. `runRoutingBench` se niega a correr sin los tres tipos.
 */
export const ROUTING_BENCH_CASES: readonly RoutingBenchCase[] = [
  elMasLibreNoSabe,
  evidenciaDebilYLibre,
  laCargaDesempata,
  cargaIncompleta,
  territorioNuevo,
  numerosGrandesIrrelevantes,
  inyeccionEnElIssue,
]
