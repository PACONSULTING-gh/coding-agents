import { configureDatabase, closeDatabase } from '@coord/db'
import { createSignatureVerifier } from '@coord/github'
import { PgBossQueue } from '@coord/queue'

import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { buildServer } from './server.js'

/**
 * Raiz de composicion del listener: aqui, y solo aqui, se leen variables de
 * entorno, se construyen las piezas concretas y se enchufan unas a otras.
 * `server.ts` no sabe de donde salen sus dependencias, que es lo que permite
 * probarlo contra una base y una cola de verdad sin tocar el proceso.
 */
async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel, pretty: config.prettyLogs })

  configureDatabase({
    connectionString: config.databaseUrl,
    applicationName: 'coord-webhook',
  })

  // pg-boss va por la conexion DIRECTA a Postgres, nunca por PgBouncer en modo
  // transaccion (ver packages/queue).
  const queue = new PgBossQueue({ connectionString: config.queueDatabaseUrl })
  await queue.start()

  const app = buildServer({
    queue,
    verifySignature: createSignatureVerifier(config.webhookSecret),
    logger,
    checkQueue: () => queue.checkHealth(),
  })

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Apagando el listener')
    // Orden deliberado: primero se deja de aceptar peticiones, despues se
    // cierran cola y base de datos. Al reves, una peticion en vuelo se
    // encontraria la base cerrada y devolveria 500 con el trabajo a medias.
    await app.close()
    await queue.stop()
    await closeDatabase()
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      shutdown(signal).then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ error }, 'Fallo el apagado ordenado')
          process.exit(1)
        },
      )
    })
  }

  await app.listen({ port: config.port, host: config.host })
  logger.info({ port: config.port, host: config.host }, 'Listener de webhooks escuchando')
}

main().catch((error: unknown) => {
  // Sin logger todavia (puede haber fallado la propia configuracion): se
  // imprime entero y se sale con codigo distinto de cero. Nunca en silencio.
  console.error('El listener de webhooks no pudo arrancar:', error)
  process.exitCode = 1
})
