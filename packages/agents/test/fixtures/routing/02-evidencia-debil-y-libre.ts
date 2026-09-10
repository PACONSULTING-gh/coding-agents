import type { RoutingBenchCase } from '../../../src/routing/bench.js'

/**
 * La version sutil del mismo fallo, y la que de verdad separa un router que
 * razona de uno que aplica una regla.
 *
 * Aqui NADIE esta sin evidencia: Diego ha tocado el fichero de la tarea, poco
 * (18 lineas en 3 commits, que es el perfil de quien arregla erratas y ajusta
 * imports) y esta libre. Elena escribio 380 lineas de ese mismo fichero y va
 * cargada.
 *
 * POR QUE ELENA: 18 lineas repartidas en 3 commits no son conocimiento del
 * modulo, son visitas. La cifra que importa no es "ha tocado el fichero" sino
 * cuanto de lo que hay vivo ahi lo escribio el. Un router que solo mire "si/no
 * tiene evidencia" y desempate por carga se equivoca justo aqui, y este es el
 * caso donde mas barato le sale equivocarse sin que nadie lo note.
 */
export const evidenciaDebilYLibre: RoutingBenchCase = {
  id: 'r02-evidencia-debil-y-libre',
  title: 'El libre ha tocado el fichero, pero de pasada',
  kind: 'atajo',
  expectedTop: 'elena',
  expectedSignal: 'ownership',
  input: {
    taskRef: '#91',
    taskTitle: 'La expansion del grafo devuelve vecinos duplicados en ciclos',
    taskBody: 'Con un ciclo A→B→A la CTE recursiva devuelve B dos veces.',
    files: ['packages/graph/src/expand.ts'],
    candidates: [
      {
        id: 'diego',
        label: 'Diego Sanz',
        ownership: [{ path: 'packages/graph/src/expand.ts', lines: 18, commits: 3 }],
        workload: 0,
        workloadIsComplete: true,
      },
      {
        id: 'elena',
        label: 'Elena Mora',
        ownership: [{ path: 'packages/graph/src/expand.ts', lines: 380, commits: 11 }],
        workload: 3,
        workloadIsComplete: true,
      },
      {
        id: 'fran',
        label: 'Fran Leon',
        ownership: [{ path: 'apps/webhook/src/server.ts', lines: 240, commits: 7 }],
        workload: 1,
        workloadIsComplete: true,
      },
    ],
  },
}
