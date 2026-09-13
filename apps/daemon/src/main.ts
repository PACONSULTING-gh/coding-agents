import { pino } from 'pino'

import { runDaemon, type BeatResponse, type HeartbeatCommand } from './daemon.js'
import type { BeatOutcome } from './beat-schedule.js'
import type { DaemonTelemetry } from './telemetry.js'

/**
 * Arranque del daemon.
 *
 *     COORD_HUB_URL=... COORD_AGENT_TOKEN=... COORD_REPO_PATH=... \
 *       pnpm --filter @coord/daemon daemon:start
 *
 * El token sale del ENTORNO y nunca de un argumento: los argumentos de un
 * proceso los ve cualquiera con `ps` en esa maquina.
 */

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Falta ${name}.`)
  }
  return value.trim()
}

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' })
const hubUrl = requiredEnv('COORD_HUB_URL')
const token = requiredEnv('COORD_AGENT_TOKEN')

async function sendBeat(
  telemetry: DaemonTelemetry,
): Promise<{ outcome: BeatOutcome; response?: BeatResponse }> {
  try {
    const respuesta = await fetch(`${hubUrl}/agents/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ telemetry }),
    })

    if (respuesta.status === 401) {
      // El hub SI se entero y dijo que no. No es un fallo de red.
      return { outcome: { kind: 'rejected', detail: '401 del hub' } }
    }
    if (!respuesta.ok) {
      // Un 5xx es el hub teniendo un mal dia: se reintenta como si no hubiera
      // red, porque el efecto es el mismo y la respuesta correcta tambien.
      return { outcome: { kind: 'unreachable', detail: `HTTP ${String(respuesta.status)}` } }
    }

    return {
      outcome: { kind: 'ok' },
      response: (await respuesta.json()) as BeatResponse,
    }
  } catch (error) {
    // Sin red, DNS, timeout. El mensaje va al detalle; no se lanza, porque
    // caerse es exactamente lo que un daemon no puede hacer.
    return {
      outcome: {
        kind: 'unreachable',
        detail: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * Que se hace con un comando, HOY.
 *
 * Se registra y se deja escrito. Inyectar un mensaje en una sesion de Claude
 * Code ya en marcha no tiene forma documentada, asi que no se finge: cuando
 * existan hooks de ciclo de vida, esto es lo unico que cambia.
 */
async function onCommand(command: HeartbeatCommand): Promise<void> {
  logger.info({ id: command.id, kind: command.kind, payload: command.payload }, 'Comando del hub')
  return Promise.resolve()
}

const resumen = await runDaemon(
  {
    repoPath: requiredEnv('COORD_REPO_PATH'),
    ...(process.env['COORD_TASK_REF'] === undefined
      ? {}
      : { taskRef: process.env['COORD_TASK_REF'] }),
  },
  {
    sendBeat,
    onCommand,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    logger,
  },
)

logger.info(resumen, 'Daemon terminado')
