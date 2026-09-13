import { NotFoundError, UnauthorizedError, ValidationError } from '@coord/core'
import { authenticateAgent, recordHeartbeat } from '@coord/db'
import { runWithTenant } from '@coord/core'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Logger } from 'pino'

/**
 * El endpoint de latidos (epic 04 / T01, issue #60).
 *
 * ===========================================================================
 * EL TOKEN VA EN LA CABECERA, NO EN EL CUERPO
 * ===========================================================================
 * Un token en el cuerpo acaba en los volcados de peticion, en los logs de
 * cualquier proxy que registre cuerpos, y en el historial de quien lo pruebe
 * con curl. `Authorization: Bearer` es donde las herramientas ya saben que no
 * hay que registrar nada.
 *
 * ===========================================================================
 * UNA SOLA RESPUESTA PARA TODO LO QUE NO AUTENTICA
 * ===========================================================================
 * Token que no existe, token revocado, agente borrado entre la autenticacion y
 * el latido: todo sale como el MISMO 401 con el MISMO cuerpo. Distinguirlos le
 * diria a quien prueba tokens cuales existieron alguna vez, y "revocado" es
 * justo la pista que convierte una lista de tokens viejos en un objetivo.
 *
 * En particular NO se devuelve 404 cuando el agente no esta: un 404 afirma que
 * el token era valido y el agente no existe, que es mas de lo que nadie sin
 * credencial tiene que poder averiguar.
 */

export const HEARTBEAT_PATH = '/agents/heartbeat'

/**
 * Tope del cuerpo de un latido.
 *
 * La telemetria la manda el daemon y es entrada no confiable: sin tope, un
 * daemon con un bug —o alguien con un token robado— puede llenar la tabla
 * `agents` a base de latidos gordos. 64 KiB es varias veces lo que cabe en
 * tarea, rama, tokens, coste y ultima llamada.
 */
export const MAX_HEARTBEAT_BYTES = 64 * 1024

export interface HeartbeatRouteDeps {
  readonly logger: Logger
}

/** `Bearer <token>`, y solo eso. */
function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  // Una cabecera repetida llega como array. No se coge "la primera": una
  // cabecera de autorizacion duplicada es una peticion manipulada, y elegir
  // cual vale seria elegir por quien la manipulo. Mismo criterio que el
  // endpoint de webhooks.
  if (typeof header !== 'string') return undefined
  const [esquema, valor] = header.split(' ')
  if (esquema?.toLowerCase() !== 'bearer') return undefined
  return valor !== undefined && valor.trim() !== '' ? valor.trim() : undefined
}

interface HeartbeatBody {
  readonly telemetry?: unknown
}

/**
 * La telemetria tal como llega. NO se interpreta aqui: se guarda como jsonb y
 * la lee el clasificador, que es quien sabe que campos espera. Lo unico que se
 * comprueba es que sea un objeto —no un array ni un numero suelto— para que la
 * columna no acabe con formas que nadie puede consultar.
 */
function telemetriaValida(valor: unknown): Readonly<Record<string, unknown>> {
  if (valor === undefined || valor === null) return {}
  if (typeof valor !== 'object' || Array.isArray(valor)) {
    throw new ValidationError(
      '`telemetry` tiene que ser un objeto. Un array o un valor suelto dejaria la columna con ' +
        'una forma que ninguna consulta de la vista de equipo puede leer.',
    )
  }
  return valor as Readonly<Record<string, unknown>>
}

/**
 * El handler, suelto y no atado al servidor.
 *
 * Se registra desde `server.ts`, que es donde los tipos de Fastify ya estan
 * parametrizados con el logger de este servicio. Sacar el handler ademas lo
 * hace probable sin levantar nada.
 */
export async function handleHeartbeat(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: HeartbeatRouteDeps,
): Promise<unknown> {
  const token = bearerToken(request)
  if (token === undefined) {
    return reply.code(401).send({ error: 'unauthorized' })
  }

  let agente
  try {
    agente = await authenticateAgent(token)
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      // Sin el token en el log: es una credencial. Lo que se registra es
      // que alguien intento latir y no pudo.
      deps.logger.warn({ ip: request.ip }, 'Latido con token no valido')
      return reply.code(401).send({ error: 'unauthorized' })
    }
    throw error
  }

  let telemetry: Readonly<Record<string, unknown>>
  try {
    telemetry = telemetriaValida((request.body as HeartbeatBody | undefined)?.telemetry)
  } catch (error) {
    if (error instanceof ValidationError) {
      return reply.code(400).send({ error: 'invalid_telemetry', detail: error.message })
    }
    throw error
  }

  try {
    const resultado = await runWithTenant({ tenantId: agente.tenantId }, () =>
      recordHeartbeat({ agentId: agente.id, telemetry }),
    )

    deps.logger.debug(
      { agentKey: agente.agentKey, comandos: resultado.commands.length },
      'Latido registrado',
    )

    // Los comandos viajan EN ESTA RESPUESTA. Es el unico canal de vuelta
    // que tiene el daemon: el hub no puede alcanzar su maquina.
    return reply.code(200).send({
      lastBeatAt: resultado.lastBeatAt.toISOString(),
      commands: resultado.commands,
    })
  } catch (error) {
    if (!esAgenteQueYaNoEsta(error)) {
      // Una caida de la base de datos NO es "el agente ya no esta". Registrarla
      // con ese mensaje mandaria a quien lea el log a buscar una revocacion que
      // nunca ocurrio, y devolver 401 le diria al daemon que su token es malo,
      // con lo que dejaria de latir por una averia pasajera.
      throw error
    }
    deps.logger.warn({ agentKey: agente.agentKey }, 'Latido de un agente que ya no esta')
    return reply.code(401).send({ error: 'unauthorized' })
  }
}

/**
 * El agente existia al autenticar y no existe al latir: lo han revocado o
 * borrado en medio. Es una carrera real —la ventana son dos consultas— y sale
 * como 401, no como 404, por lo mismo que todo lo demas: un 404 confirmaria que
 * el token era bueno.
 *
 * Vive suelto y exportado para poder probarlo. La carrera no se puede provocar
 * a voluntad desde un test de integracion, y dejar la decision dentro del
 * `catch` significaba no comprobarla nunca.
 */
export function esAgenteQueYaNoEsta(error: unknown): boolean {
  return error instanceof NotFoundError
}
