/**
 * Minimo comun denominador de un logger estructurado. Se declara aqui, con la
 * firma `(contexto, mensaje)` de pino, para que un logger de pino ya existente
 * encaje sin adaptador y para que este paquete no arrastre una dependencia de
 * logging propia (escalera de pereza, CLAUDE.md 2.4).
 */
export interface QueueLogger {
  warn(context: Record<string, unknown>, message: string): void
  error(context: Record<string, unknown>, message: string): void
}

/**
 * Logger por defecto. Escribe a stderr en JSON de una linea. Deliberadamente
 * NO es un no-op: perder en silencio el error de un job es exactamente la
 * senal de alarma que la constitucion prohibe (CLAUDE.md 7).
 */
export const consoleLogger: QueueLogger = {
  warn(context, message) {
    process.stderr.write(`${JSON.stringify({ level: 'warn', message, ...context })}\n`)
  },
  error(context, message) {
    process.stderr.write(`${JSON.stringify({ level: 'error', message, ...context })}\n`)
  },
}
