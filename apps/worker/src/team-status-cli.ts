import { buildTeamStatus, runWithTenant } from '@coord/core'
import { closeDatabase, configureDatabase, readAgentStatuses } from '@coord/db'

import { toMemberStatus } from './team-status-view.js'

/**
 * La vista de estado por CLI (epic 04 / T05, issue #64).
 *
 *     TENANT_ID=... DATABASE_URL=... pnpm --filter @coord/worker status:team
 *
 * Es una de las TRES vias decididas en el ADR 0010 —issue fijo, CLI y Slack—.
 * Esta es la que no necesita nada montado: sirve para mirar el estado mientras
 * se depura, y es la unica que funciona con la red del equipo caida.
 *
 * NO decide nada: lee y pinta. La forma de cada linea vive en
 * `buildTeamStatus`, en `packages/core`, para que las tres vias enseñen
 * exactamente lo mismo. Tres canales con tres formatos distintos acaban con
 * tres versiones de la verdad y una discusion sobre cual mirar.
 */

function requiredEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Falta ${name}. Esta vista lee el estado real de la base de datos: sin tenant ni conexion ` +
        'no hay nada que enseñar, y enseñar una lista vacia se leeria como "no hay agentes".',
    )
  }
  return value.trim()
}

async function main(): Promise<void> {
  const tenantId = requiredEnv('TENANT_ID', process.env)
  configureDatabase({ connectionString: requiredEnv('DATABASE_URL', process.env) })

  try {
    const estados = await runWithTenant({ tenantId }, () => readAgentStatuses())
    const informe = buildTeamStatus(estados.map(toMemberStatus))
    process.stdout.write(`${informe.text}\n`)

    // Codigo de salida 1 si hay alguien a quien mirar, para poder engancharlo a
    // cualquier cosa que ya sepa leer codigos de salida sin parsear texto.
    if (informe.needingAttention.length > 0) process.exitCode = 1
  } finally {
    await closeDatabase()
  }
}

// Sin try/catch: si la base no responde, el error sube con su tipo. Una vista
// de estado que se degrada a "todo bien" cuando no puede leer es peor que
// ninguna.
await main()
