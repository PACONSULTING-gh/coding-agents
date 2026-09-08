import { closeDatabase, configureDatabase, resolveRuntimeConnectionString } from '@coord/db'
import { PgBossQueue } from '@coord/queue'
import { pino } from 'pino'

import { registerGithubEventHandlers } from './github-events.js'

/**
 * Raiz de composicion del worker. Consume las colas de webhooks que llena
 * apps/webhook.
 */
function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Falta la variable de entorno ${name}. Ver .env.example.`)
  }
  return value
}

async function main(): Promise<void> {
  const logger = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    // Misma disciplina que el listener: si algun dia alguien loguea un objeto
    // de configuracion, el token no sale por aqui.
    redact: { paths: ['token', '*.token', 'privateKey', '*.privateKey', 'secret', '*.secret'] },
  })

  // La conexion DIRECTA la necesita pg-boss (estado de sesion: LISTEN/NOTIFY).
  const databaseUrl = required('DATABASE_URL')
  configureDatabase({
    // La convencion vive en @coord/db, no aqui: si cada app la compone por su
    // cuenta, tarde o temprano solo una de ellas se arregla (CLAUDE.md 2.4).
    connectionString: resolveRuntimeConnectionString(),
    applicationName: 'coord-worker',
  })

  // pg-boss necesita la conexion DIRECTA (ver packages/queue).
  const queue = new PgBossQueue({ connectionString: databaseUrl })
  await registerGithubEventHandlers(queue, logger)
  await queue.start()
  logger.info('Worker arrancado')

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'Apagando el worker')
      queue
        .stop()
        .then(() => closeDatabase())
        .then(
          () => process.exit(0),
          (error: unknown) => {
            logger.error({ error }, 'Fallo el apagado ordenado')
            process.exit(1)
          },
        )
    })
  }
}

main().catch((error: unknown) => {
  console.error('El worker no pudo arrancar:', error)
  process.exitCode = 1
})
