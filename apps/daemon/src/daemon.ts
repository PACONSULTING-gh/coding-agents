import { ValidationError } from '@coord/core'
import type { Logger } from 'pino'

import { decideNextBeat, type BeatOutcome } from './beat-schedule.js'
import { collectTelemetry, type DaemonTelemetry } from './telemetry.js'

/**
 * El bucle del daemon (epic 04 / T02, issue #61).
 *
 * Recoge telemetria, late, aplica lo que el hub conteste, y espera lo que diga
 * `decideNextBeat`. Aqui no hay ni una decision: todas estan en esa funcion,
 * que es pura y esta probada aparte.
 *
 * ===========================================================================
 * QUE SIGNIFICA "APLICAR UN COMANDO", HOY
 * ===========================================================================
 * El tercer criterio de aceptacion de T02 dice que el daemon aplica sobre la
 * sesion del agente el comando que devuelva el hub. Hoy ESO NO SE PUEDE HACER
 * DEL TODO, y conviene decirlo en vez de fingirlo: no hay forma documentada de
 * inyectar un mensaje en una sesion de Claude Code ya en marcha.
 *
 * Lo que se hace es lo que si se puede: cada comando se ENTREGA al manejador
 * que se le inyecte al daemon —por defecto, dejarlo escrito y registrado— y el
 * hub lo da por entregado. Cuando existan hooks de ciclo de vida, el manejador
 * cambia y el resto no.
 *
 * Lo que NO se hace es marcar como aplicado algo que no se aplico: el comando
 * viaja con su `kind`, y un manejador que no sepa que hacer con el tiene que
 * decirlo, no tragarselo.
 */

export interface HeartbeatCommand {
  readonly id: string
  readonly kind: string
  readonly payload: Readonly<Record<string, unknown>>
}

export interface BeatResponse {
  readonly commands: readonly HeartbeatCommand[]
}

/** Manda el latido. Devuelve como fue, no lanza: el bucle decide con eso. */
export type BeatSender = (
  telemetry: DaemonTelemetry,
) => Promise<{ readonly outcome: BeatOutcome; readonly response?: BeatResponse }>

export type CommandHandler = (command: HeartbeatCommand) => Promise<void>

export interface DaemonConfig {
  readonly repoPath: string
  readonly taskRef?: string
  readonly baseIntervalMs?: number
  readonly maxBackoffMs?: number
  /** Tope de latidos. Sin el, el bucle no termina — que es lo correcto en produccion. */
  readonly maxBeats?: number
}

export interface DaemonDeps {
  readonly sendBeat: BeatSender
  readonly onCommand: CommandHandler
  readonly sleep: (ms: number) => Promise<void>
  readonly logger: Logger
}

export interface DaemonSummary {
  readonly beats: number
  readonly commandsApplied: number
  /** Por que termino. En produccion solo deberia ser `rejected`. */
  readonly stoppedBecause: 'rejected' | 'max_beats'
}

export async function runDaemon(config: DaemonConfig, deps: DaemonDeps): Promise<DaemonSummary> {
  if (config.repoPath.trim() === '') {
    throw new ValidationError('El daemon necesita un `repoPath`: es lo que mira para el latido.')
  }

  let consecutiveFailures = 0
  let beats = 0
  let commandsApplied = 0

  for (;;) {
    const telemetry = await collectTelemetry({
      repoPath: config.repoPath,
      ...(config.taskRef === undefined ? {} : { taskRef: config.taskRef }),
    })

    const { outcome, response } = await deps.sendBeat(telemetry)
    beats += 1

    if (outcome.kind === 'ok' && response !== undefined) {
      for (const command of response.commands) {
        // Sin try/catch: si el manejador no puede aplicar un comando, el error
        // sube. Tragarselo aqui dejaria al hub creyendo que se aplico —ya lo
        // marco entregado al responder— y a la persona sin enterarse.
        await deps.onCommand(command)
        commandsApplied += 1
      }
    }

    const plan = decideNextBeat({
      outcome,
      consecutiveFailures,
      ...(config.baseIntervalMs === undefined ? {} : { baseIntervalMs: config.baseIntervalMs }),
      ...(config.maxBackoffMs === undefined ? {} : { maxBackoffMs: config.maxBackoffMs }),
    })
    consecutiveFailures = plan.consecutiveFailures

    if (plan.stop) {
      // A `error` y no a `warn`: es lo unico que hace que el daemon deje de
      // latir, y quien lo instalo tiene que poder encontrarlo sin filtrar.
      deps.logger.error({ reason: plan.reason }, 'El daemon para')
      return { beats, commandsApplied, stoppedBecause: 'rejected' }
    }

    if (outcome.kind !== 'ok') {
      deps.logger.warn({ reason: plan.reason, consecutiveFailures }, 'Latido fallido')
    }

    if (config.maxBeats !== undefined && beats >= config.maxBeats) {
      return { beats, commandsApplied, stoppedBecause: 'max_beats' }
    }

    await deps.sleep(plan.waitMs ?? 0)
  }
}
