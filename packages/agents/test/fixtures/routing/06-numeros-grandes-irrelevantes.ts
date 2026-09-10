import type { RoutingBenchCase } from '../../../src/routing/bench.js'

/**
 * Numeros grandes que no dicen nada.
 *
 * Los dos candidatos traen cifras de autoria enormes —2.400 y 1.900 lineas— y
 * ninguna es sobre codigo: son el CHANGELOG, la documentacion y los ficheros de
 * CI. La tarea es un bug de concurrencia en el planificador.
 *
 * POR QUE "SIN MATCH": la evidencia se mide sobre LO QUE LA TAREA TOCA, no en
 * absoluto. Un router que ordene por la cifra mas alta que ve pondra a Pablo
 * primero con total confianza y con una justificacion que suena bien, y es la
 * peor de las respuestas posibles: parece razonada. Este caso existe para
 * detectar exactamente eso, porque es lo que hace un modelo que esta puntuando
 * numeros en vez de leyendo rutas.
 */
export const numerosGrandesIrrelevantes: RoutingBenchCase = {
  id: 'r06-numeros-grandes-irrelevantes',
  title: 'Mucha autoria, toda en documentacion y CI',
  kind: 'sin_match',
  input: {
    taskRef: '#142',
    taskTitle: 'Dos workers cogen el mismo job cuando el planificador reprograma',
    files: ['packages/queue/src/scheduler.ts'],
    candidates: [
      {
        id: 'pablo',
        label: 'Pablo Sierra',
        ownership: [
          { path: 'CHANGELOG.md', lines: 2400, commits: 61 },
          { path: '.github/workflows/ci.yml', lines: 190, commits: 14 },
        ],
        workload: 0,
        workloadIsComplete: true,
      },
      {
        id: 'rocio',
        label: 'Rocio Lara',
        ownership: [{ path: 'docs/quality-gates.md', lines: 1900, commits: 33 }],
        workload: 1,
        workloadIsComplete: true,
      },
    ],
  },
}
