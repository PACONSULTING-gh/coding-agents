import type { RoutingBenchCase } from '../../../src/routing/bench.js'

/**
 * El contrapeso. Sin casos como este, un router que ordenase SIEMPRE por lineas
 * descendentes acertaria todos los `atajo` y seria inutil: mandaria todo a la
 * misma persona hasta enterrarla.
 *
 * Gonzalo y Hugo escribieron practicamente lo mismo del fichero (204 y 196
 * lineas) y llevan un numero de commits parecido. No hay nada en la evidencia
 * que separe a uno del otro.
 *
 * Que Hugo tenga cuatro lineas MENOS que Gonzalo es deliberado: si el que se
 * espera primero fuese ademas el de la cifra mas alta, este caso lo acertaria
 * un router que ordenase por lineas sin mirar nada mas, y entonces no estaria
 * midiendo el desempate. Cuatro lineas de diferencia no son evidencia de nada.
 *
 * POR QUE HUGO: cuando la evidencia empata de verdad, la carga es el criterio
 * que queda, y es un criterio bueno. Gonzalo lleva cinco cosas y Hugo una. El
 * epic dice que la carga es un DESEMPATE, y esto es un empate.
 *
 * Se espera `workload` como señal declarada precisamente porque aqui la carga SI
 * es lo que decide: si el router pusiera a Hugo primero y lo justificase por
 * evidencia, estaria contando bien el resultado y mal el motivo, y quien lea el
 * shortlist se llevaria una idea falsa de por que.
 */
export const laCargaDesempata: RoutingBenchCase = {
  id: 'r03-la-carga-desempata',
  title: 'Evidencia practicamente igual, cargas muy distintas',
  kind: 'desempate',
  expectedTop: 'hugo',
  expectedSignal: 'workload',
  input: {
    taskRef: '#104',
    taskTitle: 'Anadir indice por (tenant_id, created_at) a la tabla de eventos',
    taskBody: 'Las consultas del panel escanean la tabla entera al filtrar por fecha.',
    files: ['packages/db/src/events.ts'],
    candidates: [
      {
        id: 'gonzalo',
        label: 'Gonzalo Prieto',
        ownership: [{ path: 'packages/db/src/events.ts', lines: 204, commits: 7 }],
        workload: 5,
        workloadIsComplete: true,
      },
      {
        id: 'hugo',
        label: 'Hugo Vela',
        ownership: [{ path: 'packages/db/src/events.ts', lines: 196, commits: 6 }],
        workload: 1,
        workloadIsComplete: true,
      },
      {
        id: 'irene',
        label: 'Irene Nava',
        ownership: [{ path: 'packages/db/src/tenants.ts', lines: 90, commits: 3 }],
        workload: 2,
        workloadIsComplete: true,
      },
    ],
  },
}
