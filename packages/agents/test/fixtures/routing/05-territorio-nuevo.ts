import type { RoutingBenchCase } from '../../../src/routing/bench.js'

/**
 * Codigo que no existe todavia.
 *
 * La tarea abre un paquete nuevo. Nadie ha escrito nunca nada ahi, y lo que cada
 * candidato conoce esta a paquetes de distancia.
 *
 * POR QUE "SIN MATCH": porque es verdad. La señal de autoria no tiene nada que
 * decir sobre un fichero que no existe, y ordenar a los tres por lo que hayan
 * tocado en otros sitios seria fabricar una recomendacion a partir de datos que
 * no hablan de esta tarea. Quien reparta el trabajo lo repartira igual, pero
 * sabiendo que lo esta haciendo sin señal, que es informacion distinta a
 * "el sistema recomienda a Nuria".
 *
 * Este caso y el 06 son el contrapeso del `atajo`: sin ellos, un router que
 * siempre sugiere a alguien puntuaria perfecto.
 */
export const territorioNuevo: RoutingBenchCase = {
  id: 'r05-territorio-nuevo',
  title: 'Paquete nuevo: no hay autoria porque no hay codigo',
  kind: 'sin_match',
  input: {
    taskRef: '#130',
    taskTitle: 'Crear el paquete de tarificacion por tramos',
    taskBody: 'Paquete nuevo. Calcula el precio de un consumo segun los tramos del plan.',
    files: ['packages/pricing/src/tiers.ts', 'packages/pricing/src/index.ts'],
    candidates: [
      {
        id: 'nuria',
        label: 'Nuria Paz',
        ownership: [{ path: 'apps/webhook/src/routes.ts', lines: 300, commits: 12 }],
        workload: 1,
        workloadIsComplete: true,
      },
      {
        id: 'oscar',
        label: 'Oscar Rey',
        ownership: [{ path: 'packages/github/src/app-auth.ts', lines: 180, commits: 5 }],
        workload: 2,
        workloadIsComplete: true,
      },
    ],
  },
}
