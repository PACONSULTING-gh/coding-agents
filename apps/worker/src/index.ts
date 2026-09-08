import { closeDatabase, configureDatabase, resolveRuntimeConnectionString } from '@coord/db'
import { PgBossQueue } from '@coord/queue'
import { pino } from 'pino'

import { registerClaimsPurgeProcessor } from '@coord/graph'

import { registerGithubEventHandlers, registerDomainHandler } from './github-events.js'
import { createPushIngestionHandler, registerGraphIngestionHandlers } from './graph-ingestion.js'

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

  // Ingesta del grafo (epic 02, T02). Necesita un checkout local del
  // repositorio; clonarlos NO es de esta tarea. Sin `GRAPH_CHECKOUT_ROOT` el
  // enganche no se registra y se dice en el log: una decision explicita y
  // visible, no un fallo silencioso (CLAUDE.md 5).
  const checkoutRoot = process.env['GRAPH_CHECKOUT_ROOT']?.trim()
  if (checkoutRoot === undefined || checkoutRoot === '') {
    logger.warn('GRAPH_CHECKOUT_ROOT sin definir: la ingesta del grafo queda desactivada')
  } else {
    registerDomainHandler('push', createPushIngestionHandler(queue, logger))
    await registerGraphIngestionHandlers(queue, logger, { checkoutRoot })
  }

  await registerGithubEventHandlers(queue, logger)

  // Purga del historico de claims (epic 02, T04). NO forma parte de la
  // correccion —un claim caducado deja de contar por `expires_at`, ver el
  // ADR 0004—, solo recorta la tabla. El PROCESADOR se registra aqui, una vez
  // por proceso; la PROGRAMACION es por tenant (`scheduleClaimsPurge` congela
  // el tenant al programar) y se hace al aprovisionar cada tenant, que todavia
  // no existe como flujo. Sin esto, el procesador no estaba enchufado a nada.
  await registerClaimsPurgeProcessor(queue)

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
