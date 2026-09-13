import { ValidationError, type EscalationNotice, type NotificationPort } from '@coord/core'

/**
 * Slack como canal de avisos (epic 04 / T05, decidido en el ADR 0010).
 *
 * ===========================================================================
 * SIN SDK: UN POST A UN WEBHOOK ENTRANTE
 * ===========================================================================
 * Un webhook entrante de Slack es una URL a la que se hace POST de un JSON.
 * Eso es `fetch`, que ya viene en la plataforma (peldaño 3 de la escalera de
 * `CLAUDE.md` §2.4). Meter el SDK oficial traeria docenas de dependencias para
 * no usar ninguna otra cosa.
 *
 * ===========================================================================
 * LA URL DEL WEBHOOK ES UNA CREDENCIAL
 * ===========================================================================
 * Quien la tenga puede publicar en ese canal. No va al repositorio ni a un log:
 * entra por configuracion y aqui NUNCA se escribe en un mensaje de error. Si un
 * POST falla, lo que se dice es el codigo de estado, no a donde se mandaba.
 */

/**
 * Tope de un bloque de texto de Slack.
 *
 * Slack corta a 3000 caracteres POR BLOQUE, y corta EN SILENCIO. Un aviso de
 * escalado recortado por la mitad se lee como un aviso completo, asi que aqui
 * se parte a proposito y se numera: mas vale dos mensajes que uno que miente.
 */
export const SLACK_MAX_TEXT_BYTES = 2_900

/** Lo minimo de `fetch` que hace falta. Inyectable para poder probar sin red. */
export type SlackPoster = (
  url: string,
  body: string,
) => Promise<{ readonly ok: boolean; readonly status: number }>

export interface SlackNotifierConfig {
  /** URL del webhook entrante. Es una credencial: viene de configuracion. */
  readonly webhookUrl: string
  /** Para los tests. Por defecto, `fetch`. */
  readonly post?: SlackPoster
}

const defaultPoster: SlackPoster = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  return { ok: response.ok, status: response.status }
}

/**
 * Parte un texto en trozos que caben en un bloque de Slack, por LINEAS.
 *
 * Por lineas y no por caracteres porque cortar una linea de la vista de equipo
 * a la mitad produce medio nombre y medio estado, que es peor que no enseñarlo:
 * quien lo lea puede creerse la mitad que ve.
 *
 * Una linea que por si sola no cabe se deja entera y se acepta que Slack la
 * recorte: partirla seria justo lo que se quiere evitar, y es un caso que solo
 * aparece con datos anomalos.
 */
export function splitForSlack(text: string, maxBytes = SLACK_MAX_TEXT_BYTES): readonly string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new ValidationError(
      `maxBytes tiene que ser un entero >= 1 y se recibio ${String(maxBytes)}.`,
    )
  }

  const trozos: string[] = []
  let actual = ''

  for (const linea of text.split('\n')) {
    const candidato = actual === '' ? linea : `${actual}\n${linea}`
    if (Buffer.byteLength(candidato, 'utf8') <= maxBytes) {
      actual = candidato
      continue
    }
    if (actual !== '') trozos.push(actual)
    actual = linea
  }
  if (actual !== '') trozos.push(actual)
  return trozos.length === 0 ? [''] : trozos
}

/**
 * Publica un texto en Slack, partiendolo si hace falta.
 *
 * NO atrapa los fallos: se propagan. Un aviso que nadie recibe no es un aviso,
 * y descubrirlo por un log de warning es descubrirlo tarde. Es la misma regla
 * que el adaptador de GitHub.
 */
export async function postToSlack(config: SlackNotifierConfig, text: string): Promise<void> {
  if (config.webhookUrl.trim() === '') {
    throw new ValidationError(
      'Falta la URL del webhook de Slack. Sin ella no hay canal, y un notificador que no ' +
        'notifica es peor que no tener notificador: parece que avisa.',
    )
  }
  const post = config.post ?? defaultPoster
  const trozos = splitForSlack(text)

  for (const [indice, trozo] of trozos.entries()) {
    const numerado =
      trozos.length === 1
        ? trozo
        : `${trozo}\n_(${String(indice + 1)} de ${String(trozos.length)})_`
    const respuesta = await post(config.webhookUrl, JSON.stringify({ text: numerado }))
    if (!respuesta.ok) {
      // El estado, NO la URL: la URL es la credencial.
      throw new Error(
        `Slack rechazo el mensaje con estado ${String(respuesta.status)} (parte ` +
          `${String(indice + 1)} de ${String(trozos.length)}).`,
      )
    }
  }
}

/** Como se ve un escalado en Slack. Mismo contenido que en el issue, otro formato. */
function renderEscalation(notice: EscalationNotice): string {
  const lineas = [`*${notice.taskRef}* — ${notice.reason}`]

  if (notice.responsible === undefined) {
    lineas.push(
      `⚠ Sin responsable identificado. ${notice.unresolvedReason ?? 'No se ha podido determinar quien responde'}.`,
    )
  } else {
    const mencion =
      notice.mention === undefined || notice.mention.trim() === ''
        ? notice.responsible.label
        : `<@${notice.mention.trim()}>`
    lineas.push(`Responsable: ${mencion}`)
  }

  if (notice.detail !== undefined && notice.detail.trim() !== '') {
    lineas.push(`Qué pasó: ${notice.detail.trim()}`)
  }
  lineas.push(`Intentos: ${String(notice.attempts)} de ${String(notice.maxAttempts)}`)
  if (notice.headSha !== undefined) lineas.push(`Commit: \`${notice.headSha}\``)

  return lineas.join('\n')
}

/**
 * El `NotificationPort` sobre Slack.
 *
 * El informe de conformidad NO se manda por aqui a proposito: es largo, vive
 * mejor en el PR donde esta el codigo, y repetirlo en Slack invita a decidir
 * desde el movil sin tener el diff a mano. Slack dice QUE pasa y a QUIEN le
 * toca; el informe se lee donde se merge.
 */
export function createSlackNotifier(config: SlackNotifierConfig): NotificationPort {
  return {
    notifyEscalation: (notice: EscalationNotice) => postToSlack(config, renderEscalation(notice)),
  }
}
