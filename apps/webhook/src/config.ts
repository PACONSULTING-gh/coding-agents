import { resolveRuntimeConnectionString } from '@coord/db'
import { ENV_WEBHOOK_SECRET } from '@coord/github'

/**
 * Configuracion del listener, leida del entorno UNA vez en el arranque.
 *
 * Se valida todo de golpe y se falla ruidosamente si falta algo: un listener a
 * medio configurar que lo descubre con el primer webhook es un listener que ya
 * ha perdido eventos, y GitHub solo reintenta unas cuantas veces.
 *
 * No se usa zod aqui porque `zod` no es dependencia de esta app y lo que hay
 * que validar son cuatro variables (escalera de pereza, CLAUDE.md 2.4).
 */

export interface WebhookConfig {
  /**
   * Secreto compartido con el que GitHub firma los webhooks. Es LO UNICO que
   * este proceso necesita de la GitHub App.
   *
   * LEE ESTO ANTES DE VOLVER A METER AQUI githubAppConfigFromEnv(). Antes se
   * cargaba la configuracion completa de la App, incluida la CLAVE PRIVADA
   * decodificada en memoria, y despues no se usaba: el listener solo verifica
   * firmas, no llama a la API de GitHub. Eso era superficie de exposicion
   * regalada -un volcado de memoria o un logueo accidental de la configuracion-
   * en el unico proceso del sistema expuesto a internet, y ademas impedia
   * desplegar un listener al que solo se le quiera dar el secreto de webhook.
   * El proceso que si habla con la API (apps/worker) es el que construye la App.
   */
  webhookSecret: string
  /** Conexion de RUNTIME a Postgres (via PgBouncer en produccion). */
  databaseUrl: string
  /**
   * Conexion DIRECTA a Postgres para pg-boss. No puede ir por PgBouncer en
   * modo transaccion: pg-boss necesita estado de sesion (LISTEN/NOTIFY).
   * Ver la advertencia de despliegue en packages/queue.
   */
  queueDatabaseUrl: string
  port: number
  host: string
  logLevel: string
  prettyLogs: boolean
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Falta la variable de entorno ${name}. Ver .env.example.`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WebhookConfig {
  const rawPort = env['WEBHOOK_PORT'] ?? '3000'
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`WEBHOOK_PORT debe ser un puerto valido. Recibido: ${rawPort}`)
  }

  // La convencion PGBOUNCER_URL / DATABASE_URL vive en @coord/db, en un solo
  // sitio, y avisa si se cae al Postgres directo.
  const databaseUrl = resolveRuntimeConnectionString(env)

  return {
    webhookSecret: required(env, ENV_WEBHOOK_SECRET),
    databaseUrl,
    // pg-boss va SIEMPRE por la conexion directa, aunque el resto pase por
    // PgBouncer.
    queueDatabaseUrl: required(env, 'DATABASE_URL'),
    port,
    host: env['WEBHOOK_HOST'] ?? '0.0.0.0',
    logLevel: env['LOG_LEVEL'] ?? 'info',
    prettyLogs: env['NODE_ENV'] === 'development',
  }
}
