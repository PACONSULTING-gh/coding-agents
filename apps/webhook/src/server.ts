import { runWithTenant, type QueuePort } from '@coord/core'
import {
  appendAuditEntry,
  findInstallationRouting,
  forgetWebhookDelivery,
  pingDatabase,
  recordWebhookDelivery,
  withTenantConnection,
} from '@coord/db'
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  extractAction,
  extractInstallationId,
  isSubscribedEvent,
  queueNameForEvent,
  type GithubWebhookJob,
  type SignatureRejection,
  type SignatureVerifier,
} from '@coord/github'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import type { Logger } from 'pino'

/**
 * Listener HTTP de webhooks de GitHub.
 *
 * ---------------------------------------------------------------------------
 * EL PRINCIPIO QUE GOBIERNA ESTE FICHERO
 * ---------------------------------------------------------------------------
 * EL LISTENER NO PROCESA NADA. Verifica la firma, deduplica por GUID de
 * entrega, encola y responde 2XX. Punto. Cualquier logica de dominio que
 * aparezca en este handler esta en el sitio equivocado: va a apps/worker.
 *
 * El motivo no es estetico. GitHub corta la entrega a los 10 segundos y
 * reintenta; y el epic pide responder en menos de 500 ms. Cualquier trabajo que
 * se haga aqui es trabajo que se hace CON EL RELOJ DE GITHUB CORRIENDO, con la
 * peticion abierta y sin reintentos propios. En la cola, en cambio, el trabajo
 * tiene reintentos con backoff y cola de fallidos.
 *
 * Por eso el evento `installation` tampoco se aplica aqui: se encola como todo
 * lo demas y lo aplica el worker.
 */

/** Ruta del webhook. Es la que se configura en la GitHub App. */
export const WEBHOOK_PATH = '/webhooks/github'

/**
 * GitHub no entrega payloads de mas de 25 MB. Se pone ese tope y no el de
 * Fastify (1 MB) porque un `push` con muchos commits lo supera de sobra, y se
 * pone un tope y no ninguno porque el cuerpo se lee entero en memoria para
 * poder verificar el HMAC sobre los bytes crudos.
 */
export const MAX_BODY_BYTES = 25 * 1024 * 1024

/**
 * Tope del cuerpo que se acepta parsear para dejar constancia de un intento con
 * firma INVALIDA.
 *
 * El cuerpo de una peticion rechazada no esta autenticado: parsear hasta 25 MB
 * de JSON que nos manda cualquiera, y encima antes de responder el 401, es
 * trabajo regalado a quien no ha demostrado nada. Lo unico que se busca ahi
 * dentro es `installation.id`, que en cualquier evento real de GitHub aparece
 * en los primeros cientos de bytes. Por encima de este tope no se parsea: se
 * rechaza igual y se registra en el log, simplemente sin fila en `audit_log`.
 */
export const MAX_AUDITED_REJECTION_BYTES = 256 * 1024

export interface WebhookServerDeps {
  queue: QueuePort
  verifySignature: SignatureVerifier
  logger: Logger
  /** Comprobacion de vida de la cola. Se inyecta para no atar el servidor a pg-boss. */
  checkQueue: () => Promise<void>
}

/** Resultado del handler, tal como sale en el cuerpo de la respuesta y en el log. */
type DeliveryOutcome = 'queued' | 'duplicate' | 'unmapped' | 'ignored'

/**
 * Una cabecera repetida llega como array. No se coge "la primera": una cabecera
 * de firma o de GUID duplicada es una peticion que alguien ha manipulado, y
 * elegir cual vale seria elegir por el atacante.
 */
function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function parseJsonBody(raw: Buffer): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    // No se propaga: llegar aqui significa que el cuerpo no es JSON, y eso es
    // una respuesta 400, no una excepcion del proceso. El llamante distingue el
    // caso por el `undefined` y lo registra.
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined
}

/**
 * Deja constancia de un intento con firma invalida.
 *
 * Siempre en el log estructurado. En `audit_log` solo si la entrega se puede
 * atribuir a un tenant, porque `audit_log` esta bajo RLS y toda fila necesita
 * tenant.
 *
 * Compromiso consciente: para saber el tenant hay que mirar un cuerpo que NO
 * esta verificado. Se hace sin confiar en el (solo se lee el `installation.id`,
 * y solo si es un entero) y el trabajo se limita a un SELECT por indice unico;
 * si la instalacion no existe, no se escribe nada. Un atacante que no conozca
 * un installation_id valido no consigue escribir en `audit_log`. El control de
 * volumen de peticiones no autenticadas es de la capa de red, no de aqui.
 */
async function auditRejectedDelivery(
  logger: Logger,
  context: {
    reason: SignatureRejection
    deliveryId: string | undefined
    event: string | undefined
    ip: string
    body: Buffer
  },
): Promise<void> {
  if (context.body.byteLength > MAX_AUDITED_REJECTION_BYTES) {
    logger.warn(
      {
        deliveryId: context.deliveryId,
        bytes: context.body.byteLength,
        reason: context.reason,
        ip: context.ip,
      },
      'Intento con firma invalida y cuerpo demasiado grande: se rechaza sin parsearlo ni auditarlo',
    )
    return
  }

  const payload = parseJsonBody(context.body)
  const installationId = extractInstallationId(payload)
  if (installationId === undefined) {
    return
  }

  const routing = await findInstallationRouting(installationId)
  if (routing === undefined) {
    return
  }

  await runWithTenant({ tenantId: routing.tenantId }, () =>
    withTenantConnection((tx) =>
      appendAuditEntry(tx, {
        action: 'github.webhook.signature_rejected',
        resourceType: 'github_webhook',
        resourceId: context.deliveryId ?? 'desconocido',
        actorType: 'system',
        metadata: {
          reason: context.reason,
          event: context.event ?? null,
          ip: context.ip,
          installationId,
        },
        ...(context.deliveryId === undefined ? {} : { requestId: context.deliveryId }),
      }),
    ),
  )
  logger.warn(
    { deliveryId: context.deliveryId, tenantId: routing.tenantId },
    'Intento con firma invalida registrado en audit_log',
  )
}

// El tipo de retorno se infiere: pasarle a Fastify una instancia concreta de
// pino especializa el tipo de la instancia, y anotarlo como `FastifyInstance`
// generico lo perderia (y no compila con exactOptionalPropertyTypes).
export function buildServer(deps: WebhookServerDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: MAX_BODY_BYTES,
    // GitHub no manda `x-request-id`; el identificador de correlacion util es
    // el GUID de entrega, que se anade a mano en cada linea de log. Sin esto,
    // cada entrega dejaria dos lineas mas sin ese GUID y con menos contexto.
    //
    // Fastify 5 marca esta opcion como deprecada en favor de `logController`,
    // pero `logController` no admite un objeto parcial: exige las diez
    // propiedades del controlador, es decir, reimplementar el que Fastify ya
    // trae para cambiar un booleano. Se migrara cuando la 6 lo obligue.
    disableRequestLogging: true,
  })

  /**
   * Parser propio: conserva el cuerpo CRUDO.
   *
   * Es el requisito del que depende toda la verificacion. El HMAC se calcula
   * sobre los bytes exactos que mando GitHub; si Fastify hiciera `JSON.parse` y
   * despues hubiera que reserializar para verificar, cualquier diferencia de
   * orden de claves, espacios o escapado cambiaria el hash y la firma no
   * cuadraria nunca. El `JSON.parse` se hace aqui abajo, DESPUES de verificar.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body: Buffer, done) => {
      done(null, body)
    },
  )

  app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    // Comprobaciones DE VERDAD, en paralelo: si la base o la cola estan caidas,
    // este endpoint tiene que decirlo. Un health check que solo devuelve "ok"
    // es peor que ninguno, porque da una falsa sensacion de vigilancia.
    const [database, queue] = await Promise.allSettled([pingDatabase(), deps.checkQueue()])

    const checks = {
      database: database.status === 'fulfilled',
      queue: queue.status === 'fulfilled',
    }
    if (checks.database && checks.queue) {
      return reply.code(200).send({ status: 'ok', checks })
    }

    // El motivo va al log entero (con la causa) y al cuerpo solo el nombre de
    // lo que falla: un endpoint de salud publico no describe la infraestructura.
    deps.logger.error(
      {
        databaseError: database.status === 'rejected' ? database.reason : undefined,
        queueError: queue.status === 'rejected' ? queue.reason : undefined,
      },
      'Health check en rojo',
    )
    return reply.code(503).send({ status: 'degraded', checks })
  })

  app.post(WEBHOOK_PATH, async (request: FastifyRequest, reply: FastifyReply) => {
    const startedAt = process.hrtime.bigint()
    const headers = request.headers
    const deliveryId = singleHeader(headers[DELIVERY_HEADER])
    const event = singleHeader(headers[EVENT_HEADER])
    const signature = singleHeader(headers[SIGNATURE_HEADER])
    const ip = request.ip

    const raw = request.body
    if (!Buffer.isBuffer(raw)) {
      deps.logger.warn({ deliveryId, event, ip }, 'Cuerpo de webhook ausente o no binario')
      return reply.code(400).send({ error: 'cuerpo_invalido' })
    }

    // ------------------------------------------------------------------
    // 1. Firma. Frontera de confianza: hasta aqui, el cuerpo no vale nada.
    // ------------------------------------------------------------------
    const verification = await deps.verifySignature(raw, signature)
    if (!verification.valid) {
      // Nunca un 500 silencioso: se responde 401 y se registra SIEMPRE, con IP,
      // GUID de entrega y motivo.
      deps.logger.warn(
        { deliveryId, event, ip, reason: verification.reason },
        'Webhook rechazado: firma invalida',
      )
      try {
        await auditRejectedDelivery(deps.logger, {
          reason: verification.reason,
          deliveryId,
          event,
          ip,
          body: raw,
        })
      } catch (error) {
        // Que falle el registro en audit_log no puede convertir un 401 en un
        // 500, pero tampoco puede desaparecer: se registra con su causa.
        deps.logger.error(
          { deliveryId, ip, error },
          'No se pudo registrar en audit_log el intento con firma invalida',
        )
      }
      return reply.code(401).send({ error: 'firma_invalida' })
    }

    if (deliveryId === undefined || event === undefined) {
      deps.logger.warn({ deliveryId, event, ip }, 'Webhook sin cabeceras de entrega o de evento')
      return reply.code(400).send({ error: 'cabeceras_incompletas' })
    }

    const payload = parseJsonBody(raw)
    if (payload === undefined) {
      // La firma era valida, asi que esto viene de GitHub de verdad: un cuerpo
      // que no es un objeto JSON es un cambio de contrato, no un ataque.
      deps.logger.error(
        { deliveryId, event },
        'Webhook firmado con cuerpo que no es un objeto JSON',
      )
      return reply.code(400).send({ error: 'cuerpo_no_json' })
    }

    // ------------------------------------------------------------------
    // 2. Eventos a los que no estamos suscritos (incluido el `ping` de alta).
    // ------------------------------------------------------------------
    if (!isSubscribedEvent(event)) {
      return finish(
        reply,
        deps,
        { outcome: 'ignored', deliveryId, event, startedAt },
        {
          reason: 'evento_no_suscrito',
        },
      )
    }

    const installationId = extractInstallationId(payload)
    if (installationId === undefined) {
      return finish(
        reply,
        deps,
        { outcome: 'ignored', deliveryId, event, startedAt },
        {
          reason: 'sin_instalacion',
        },
      )
    }

    // ------------------------------------------------------------------
    // 3. Instalacion -> tenant. Ocurre ANTES de tener contexto de tenant.
    // ------------------------------------------------------------------
    const routing = await findInstallationRouting(installationId)
    if (routing === undefined) {
      // 200 y no 4xx a proposito: a GitHub no le sirve reintentar una entrega
      // que no sabemos de quien es. Reintentar no crea el mapeo; lo crea una
      // persona (CLAUDE.md 2.1). Queda en el log para que se vea.
      deps.logger.warn(
        { deliveryId, event, installationId },
        'Webhook de una instalacion que no esta mapeada a ningun tenant',
      )
      return finish(
        reply,
        deps,
        { outcome: 'unmapped', deliveryId, event, startedAt },
        {
          installationId,
        },
      )
    }

    // ------------------------------------------------------------------
    // 4. Deduplicacion + encolado, ya con el tenant fijado.
    // ------------------------------------------------------------------
    const job: GithubWebhookJob = {
      deliveryId,
      event,
      action: extractAction(payload),
      installationId,
      payload,
    }

    const outcome = await runWithTenant(
      { tenantId: routing.tenantId, requestId: deliveryId },
      async (): Promise<DeliveryOutcome> => {
        const isNew = await withTenantConnection((tx) =>
          recordWebhookDelivery(tx, { deliveryId, event }),
        )
        if (!isNew) {
          return 'duplicate'
        }

        try {
          await deps.queue.enqueue(queueNameForEvent(event), job)
        } catch (error) {
          // La marca de entrega y el job NO caben en la misma transaccion (la
          // cola tiene su propio pool). Si el encolado falla despues de marcar,
          // hay que deshacer la marca: si no, la reentrega de GitHub se
          // descartaria por duplicada y el evento se perderia en silencio.
          await withTenantConnection((tx) => forgetWebhookDelivery(tx, deliveryId)).catch(
            (compensationError: unknown) => {
              deps.logger.error(
                { deliveryId, event, error: compensationError },
                'FALLO LA COMPENSACION: la entrega queda marcada como recibida pero no se encolo. ' +
                  'La reentrega de GitHub se descartara como duplicada. Requiere intervencion.',
              )
            },
          )
          throw error
        }
        return 'queued'
      },
    )

    return finish(
      reply,
      deps,
      { outcome, deliveryId, event, startedAt },
      {
        tenantId: routing.tenantId,
        installationId,
      },
    )
  })

  return app
}

interface FinishContext {
  outcome: DeliveryOutcome
  deliveryId: string | undefined
  event: string | undefined
  startedAt: bigint
}

/** Responde 200 y deja una linea de log con el desenlace y el tiempo empleado. */
function finish(
  reply: FastifyReply,
  deps: WebhookServerDeps,
  context: FinishContext,
  extra: Record<string, unknown>,
): FastifyReply {
  const elapsedMs = Number(process.hrtime.bigint() - context.startedAt) / 1e6
  deps.logger.info(
    {
      deliveryId: context.deliveryId,
      event: context.event,
      outcome: context.outcome,
      elapsedMs,
      ...extra,
    },
    'Webhook atendido',
  )
  return reply.code(200).send({ status: context.outcome })
}
