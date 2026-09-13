import { pino } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BeatOutcome } from '../src/beat-schedule.js'
import type { DaemonTelemetry } from '../src/telemetry.js'
import { runDaemon, type BeatResponse, type HeartbeatCommand } from '../src/daemon.js'

import { createTempRepo, type TempRepo } from '../../../packages/graph/test/support/git-repo.js'

/**
 * El bucle del daemon (epic 04 / T02).
 *
 * Aqui no se prueban las esperas —eso es `decideNextBeat`, puro y probado
 * aparte— sino lo que solo se ve montandolo: que un rechazo PARA el bucle, que
 * un fallo de red NO lo para, y que un comando que no se puede aplicar no se da
 * por aplicado.
 */

const logger = pino({ level: 'silent' })
let repo: TempRepo | undefined

afterEach(async () => {
  await repo?.cleanup()
  repo = undefined
})

async function repoBase(): Promise<TempRepo> {
  const r = await createTempRepo('daemon')
  await r.write('a.ts', 'export const a = 1\n')
  await r.commit('base')
  return r
}

function deps(
  resultados: { outcome: BeatOutcome; response?: BeatResponse }[],
  onCommand = vi.fn(() => Promise.resolve()),
) {
  const esperas: number[] = []
  const latidos: DaemonTelemetry[] = []
  return {
    // El mock declara su argumento: sin eso, vitest infiere `[]` como lista de
    // parametros y `mock.calls[0][0]` no compila. Y es justo lo que hay que
    // poder mirar — que la telemetria que viaja es la de verdad.
    // El mock declara su argumento y lo GUARDA: sin declararlo, vitest infiere
    // `[]` como lista de parametros y `mock.calls[0][0]` no compila. Y es justo
    // lo que hay que poder mirar — que la telemetria que viaja es la de verdad.
    sendBeat: vi.fn((telemetry: DaemonTelemetry) => {
      latidos.push(telemetry)
      return Promise.resolve(
        resultados.shift() ?? { outcome: { kind: 'ok' as const }, response: { commands: [] } },
      )
    }),
    onCommand,
    sleep: (ms: number) => {
      esperas.push(ms)
      return Promise.resolve()
    },
    logger,
    esperas,
    latidos,
  }
}

describe('el bucle', () => {
  it('late, recoge telemetria de verdad y sigue', async () => {
    repo = await repoBase()
    await repo.write('a.ts', 'export const a = 2\n')
    const d = deps([])

    const resumen = await runDaemon({ repoPath: repo.path, maxBeats: 2 }, d)

    expect(resumen.beats).toBe(2)
    expect(resumen.stoppedBecause).toBe('max_beats')
    // La telemetria que viaja es la real: hay un fichero sin commitear.
    expect(d.latidos[0]).toMatchObject({ branch: 'main', dirtyFileCount: 1 })
  })

  it('un fallo de red NO para el daemon', async () => {
    // El portatil se suspende, el wifi se cae, se cambia de red. Parar aqui
    // dejaria al equipo sin saber nada de esa maquina para siempre.
    repo = await repoBase()
    const d = deps([
      { outcome: { kind: 'unreachable', detail: 'ENOTFOUND' } },
      { outcome: { kind: 'unreachable', detail: 'ETIMEDOUT' } },
    ])

    const resumen = await runDaemon({ repoPath: repo.path, maxBeats: 3 }, d)

    expect(resumen.beats).toBe(3)
    expect(resumen.stoppedBecause).toBe('max_beats')
  })

  it('un token rechazado PARA el daemon, y no sigue latiendo', async () => {
    // El hub se entero y dijo que no. Reintentar es ruido que nadie va a
    // arreglar mirando.
    repo = await repoBase()
    const d = deps([{ outcome: { kind: 'rejected', detail: '401 del hub' } }])

    const resumen = await runDaemon({ repoPath: repo.path, maxBeats: 10 }, d)

    expect(resumen.beats).toBe(1)
    expect(resumen.stoppedBecause).toBe('rejected')
    expect(d.sendBeat).toHaveBeenCalledTimes(1)
  })
})

describe('los comandos que devuelve el hub', () => {
  const COMANDO: HeartbeatCommand = { id: 'c1', kind: 'nudge', payload: { texto: 'sigue' } }

  it('se entregan al manejador', async () => {
    repo = await repoBase()
    const onCommand = vi.fn(() => Promise.resolve())
    const d = deps([{ outcome: { kind: 'ok' }, response: { commands: [COMANDO] } }], onCommand)

    const resumen = await runDaemon({ repoPath: repo.path, maxBeats: 1 }, d)

    expect(onCommand).toHaveBeenCalledWith(COMANDO)
    expect(resumen.commandsApplied).toBe(1)
  })

  it('uno que el manejador NO sabe aplicar hace fallar el latido, no se traga', async () => {
    // El hub ya lo marco entregado al responder. Tragarse el error aqui lo
    // dejaria creyendo que se aplico, y a la persona sin enterarse de que su
    // agente ignoro una orden.
    repo = await repoBase()
    const onCommand = vi.fn(() => Promise.reject(new Error('no se aplicar `stop`')))
    const d = deps(
      [{ outcome: { kind: 'ok' }, response: { commands: [{ ...COMANDO, kind: 'stop' }] } }],
      onCommand,
    )

    await expect(runDaemon({ repoPath: repo.path, maxBeats: 1 }, d)).rejects.toThrow(
      /no se aplicar/,
    )
  })

  it('un latido fallido no entrega comandos de una respuesta que no llego', async () => {
    repo = await repoBase()
    const onCommand = vi.fn(() => Promise.resolve())
    const d = deps([{ outcome: { kind: 'unreachable', detail: 'x' } }], onCommand)

    await runDaemon({ repoPath: repo.path, maxBeats: 1 }, d)
    expect(onCommand).not.toHaveBeenCalled()
  })
})

describe('lo que se le pasa al planificador y al recolector', () => {
  it('la tarea configurada viaja en la telemetria', async () => {
    repo = await repoBase()
    const d = deps([])

    await runDaemon({ repoPath: repo.path, taskRef: 'issue-42', maxBeats: 1 }, d)

    expect(d.latidos[0]).toMatchObject({ taskRef: 'issue-42' })
  })

  it('sin tarea configurada, la clave NO viaja vacia', async () => {
    // La forma del objeto es el contrato con el hub, que lo guarda como jsonb:
    // `{taskRef: undefined}` y "sin taskRef" se leen distinto al consultarlo.
    repo = await repoBase()
    const d = deps([])

    await runDaemon({ repoPath: repo.path, maxBeats: 1 }, d)

    expect(Object.keys(d.latidos[0] ?? {})).not.toContain('taskRef')
  })

  it('el intervalo configurado se respeta', async () => {
    // Si no llegara hasta `decideNextBeat`, un daemon configurado para latir
    // despacio latiria al ritmo por defecto y nadie lo notaria hasta ver la
    // factura de limites.
    repo = await repoBase()
    const d = deps([])

    await runDaemon({ repoPath: repo.path, baseIntervalMs: 10_000, maxBeats: 2 }, d)

    expect(d.esperas[0]).toBe(10_000)
  })

  it('el tope de espera configurado tambien', async () => {
    repo = await repoBase()
    const d = deps([
      { outcome: { kind: 'unreachable', detail: 'x' } },
      { outcome: { kind: 'unreachable', detail: 'x' } },
      { outcome: { kind: 'unreachable', detail: 'x' } },
    ])

    await runDaemon(
      { repoPath: repo.path, baseIntervalMs: 1_000, maxBackoffMs: 1_500, maxBeats: 3 },
      d,
    )

    for (const espera of d.esperas) {
      expect(espera).toBeLessThanOrEqual(1_500)
    }
  })

  it('una respuesta OK sin cuerpo no entrega comandos ni revienta', async () => {
    // El hub puede contestar 200 con un cuerpo que no se pudo parsear. Es raro,
    // y caerse por ello dejaria la maquina sin latir por un cuerpo mal formado.
    repo = await repoBase()
    const onCommand = vi.fn(() => Promise.resolve())
    const d = deps([{ outcome: { kind: 'ok' } }], onCommand)

    const resumen = await runDaemon({ repoPath: repo.path, maxBeats: 1 }, d)

    expect(onCommand).not.toHaveBeenCalled()
    expect(resumen.commandsApplied).toBe(0)
  })
})

describe('la frontera de entrada', () => {
  it('sin repoPath se rechaza', async () => {
    await expect(runDaemon({ repoPath: '  ', maxBeats: 1 }, deps([]))).rejects.toThrow(/repoPath/)
  })
})
