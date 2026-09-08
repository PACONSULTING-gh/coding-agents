import { pino, type Logger, type LoggerOptions } from 'pino'

/**
 * Logger estructurado del listener.
 *
 * ---------------------------------------------------------------------------
 * REDACCION: LO IMPORTANTE DE ESTE FICHERO
 * ---------------------------------------------------------------------------
 * Por este proceso pasan tres cosas que no pueden acabar en un log: el secreto
 * de webhook, la clave privada de la App y los tokens de instalacion. Un token
 * de instalacion tiene permiso de escritura sobre los repositorios del cliente,
 * asi que verlo en un log significa verlo tambien en el sistema de logs, en sus
 * copias de seguridad y en la pantalla de cualquiera que las abra.
 *
 * La lista de `redact` es la red de seguridad, no la primera defensa: el codigo
 * simplemente no loguea esos valores. Se declara igualmente porque "nadie los
 * loguea" es cierto hasta que alguien anade un `logger.info({ config })` con
 * buena intencion.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hub-signature"]',
  'req.headers["x-hub-signature-256"]',
  'headers.authorization',
  'token',
  '*.token',
  'privateKey',
  '*.privateKey',
  'webhookSecret',
  '*.webhookSecret',
  'secret',
  '*.secret',
]

export interface LoggerConfig {
  level: string
  /** Salida legible por humanos. Solo en desarrollo: en produccion, JSON. */
  pretty: boolean
}

export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTADO]' },
    // La firma se registra por su presencia, nunca por su valor; y del cuerpo
    // no se registra nada. El serializador de peticion se queda en lo minimo
    // para correlacionar: metodo, ruta e IP.
    serializers: {
      req(request: { method?: string; url?: string; ip?: string }) {
        return { method: request.method, url: request.url, ip: request.ip }
      },
    },
    ...(config.pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: true } } }
      : {}),
  }
  return pino(options)
}
