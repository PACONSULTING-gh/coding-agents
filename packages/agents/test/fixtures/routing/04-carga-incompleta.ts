import type { RoutingBenchCase } from '../../../src/routing/bench.js'

/**
 * Un cero que no significa cero.
 *
 * Julia y Luis tienen la misma evidencia sobre el fichero. La carga de Luis
 * viene marcada como INCOMPLETA: no se pudieron leer sus issues abiertos, asi
 * que su "0" quiere decir "no se sabe", no "esta libre". La de Julia es completa
 * y vale 2.
 *
 * POR QUE JULIA: entre una carga conocida y una desconocida, la conocida es la
 * unica sobre la que se puede razonar. Tratar el cero de Luis como
 * disponibilidad es exactamente la mentira que T01 se dedico a evitar en el
 * calculo de la carga —una lista truncada no es una lista completa— y seria
 * absurdo que el modulo que la genera fuera honesto y el que la lee no.
 *
 * Luis tiene ademas cinco lineas MAS que Julia, por lo mismo que en el caso 03:
 * si la respuesta correcta fuese tambien la de la cifra mas alta, este caso lo
 * acertaria un router que ordenase por lineas y no mediria nada.
 *
 * Ojo: este caso no premia "elegir siempre al de carga conocida". Premia no
 * premiar un desconocido por parecer cero. La señal correcta sigue siendo la
 * carga, porque es lo que decide.
 */
export const cargaIncompleta: RoutingBenchCase = {
  id: 'r04-carga-incompleta',
  title: 'Uno de los dos tiene la carga sin medir, y su cero no es un cero',
  kind: 'desempate',
  expectedTop: 'julia',
  expectedSignal: 'workload',
  input: {
    taskRef: '#118',
    taskTitle: 'El worker no libera el lock cuando el job muere por timeout',
    files: ['packages/queue/src/worker.ts'],
    candidates: [
      {
        id: 'julia',
        label: 'Julia Cano',
        ownership: [{ path: 'packages/queue/src/worker.ts', lines: 205, commits: 8 }],
        workload: 2,
        workloadIsComplete: true,
      },
      {
        id: 'luis',
        label: 'Luis Bravo',
        ownership: [{ path: 'packages/queue/src/worker.ts', lines: 210, commits: 8 }],
        workload: 0,
        workloadIsComplete: false,
      },
      {
        id: 'marta',
        label: 'Marta Riu',
        ownership: [{ path: 'packages/queue/src/schedule.ts', lines: 60, commits: 2 }],
        workload: 1,
        workloadIsComplete: true,
      },
    ],
  },
}
