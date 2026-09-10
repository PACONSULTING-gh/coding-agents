import type { RoutingBenchCase } from '../../../src/routing/bench.js'

/**
 * El caso que da nombre al epic, en su forma mas cruda.
 *
 * Bruno es el que MENOS carga tiene (cero) y el que MENOS sabe del fichero que
 * la tarea toca (nada). Ana escribio 412 de las lineas vivas de ese fichero y
 * tiene cuatro cosas entre manos.
 *
 * POR QUE ANA ES LA RESPUESTA CORRECTA: la tarea es un bug de duplicado en la
 * logica de reintento, o sea, exactamente el codigo que Ana escribio. Mandarsela
 * a Bruno porque esta libre significa que Bruno se pasa dos dias entendiendo el
 * fichero antes de tocar nada, y que la revision se la acaba haciendo Ana igual.
 * Que Ana este ocupada es un problema real y por eso la carga se declara y se
 * ve, pero es un argumento para renegociar prioridades, no para reasignar el
 * bug a quien no puede arreglarlo.
 */
export const elMasLibreNoSabe: RoutingBenchCase = {
  id: 'r01-el-mas-libre-no-sabe',
  title: 'El unico que conoce el fichero es el que mas cargado va',
  kind: 'atajo',
  expectedTop: 'ana',
  expectedSignal: 'ownership',
  input: {
    taskRef: '#77',
    taskTitle: 'El reintento de cobro duplica el cargo cuando la pasarela tarda mas de 30s',
    taskBody:
      'Dos clientes reportan cargos duplicados. Pasa cuando la pasarela responde tarde y el ' +
      'reintento entra antes de que llegue la confirmacion del primer intento.',
    files: ['packages/billing/src/retry.ts'],
    candidates: [
      {
        id: 'ana',
        label: 'Ana Ruiz',
        ownership: [{ path: 'packages/billing/src/retry.ts', lines: 412, commits: 9 }],
        workload: 4,
        workloadIsComplete: true,
      },
      {
        id: 'bruno',
        label: 'Bruno Diaz',
        ownership: [],
        workload: 0,
        workloadIsComplete: true,
      },
      {
        id: 'carla',
        label: 'Carla Gil',
        ownership: [{ path: 'packages/billing/src/gateway.ts', lines: 130, commits: 4 }],
        workload: 1,
        workloadIsComplete: true,
      },
    ],
  },
}
