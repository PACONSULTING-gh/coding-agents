import { ValidationError, type EscalationNotice } from '@coord/core'
import { describe, expect, it, vi } from 'vitest'

import {
  createSlackNotifier,
  postToSlack,
  SLACK_MAX_TEXT_BYTES,
  splitForSlack,
} from '../src/notifier.js'

/**
 * El canal de Slack (epic 04 / T05).
 *
 * Lo que importa: que un mensaje largo NO se recorte en silencio —Slack corta a
 * 3000 caracteres por bloque y no avisa— y que un fallo al publicar se
 * propague. Un aviso que nadie recibe no es un aviso.
 */

function poster(respuestas: { ok: boolean; status: number }[] = []) {
  const enviados: { url: string; body: string }[] = []
  const post = vi.fn((url: string, body: string) => {
    enviados.push({ url, body })
    return Promise.resolve(respuestas.shift() ?? { ok: true, status: 200 })
  })
  return { post, enviados }
}

const WEBHOOK = 'https://hooks.slack.test/services/T/B/XXXX'

describe('un mensaje largo se parte, no se recorta', () => {
  it('por LINEAS, para no partir un nombre por la mitad', () => {
    // Cortar una linea de la vista de equipo a la mitad produce medio nombre y
    // medio estado, y quien lo lea puede creerse la mitad que ve.
    const lineas = Array.from({ length: 400 }, (_v, i) => `linea numero ${String(i)} con relleno`)
    const trozos = splitForSlack(lineas.join('\n'))

    expect(trozos.length).toBeGreaterThan(1)
    for (const trozo of trozos) {
      expect(Buffer.byteLength(trozo, 'utf8')).toBeLessThanOrEqual(SLACK_MAX_TEXT_BYTES)
      // Ninguna linea quedo cortada: todas las que hay estan enteras.
      for (const linea of trozo.split('\n')) {
        expect(lineas).toContain(linea)
      }
    }
  })

  it('lo que cabe se manda en un solo mensaje, sin numerar', async () => {
    const { post, enviados } = poster()
    await postToSlack({ webhookUrl: WEBHOOK, post }, 'algo corto')

    expect(post).toHaveBeenCalledTimes(1)
    expect(enviados[0]?.body).not.toContain('de 1')
  })

  it('lo que no cabe se numera, para que se note que hay mas', async () => {
    // Sin numerar, quien reciba la primera mitad no tiene forma de saber que
    // falta la otra.
    const { post, enviados } = poster()
    await postToSlack(
      { webhookUrl: WEBHOOK, post },
      Array.from({ length: 400 }, (_v, i) => `linea ${String(i)} con bastante relleno`).join('\n'),
    )

    expect(post.mock.calls.length).toBeGreaterThan(1)
    expect(enviados[0]?.body).toContain('1 de')
  })

  it('una linea que por si sola no cabe se deja entera', () => {
    // Partirla seria justo lo que se quiere evitar. Solo pasa con datos
    // anomalos, y se prefiere que Slack la recorte a recortarla nosotros.
    const gorda = 'x'.repeat(SLACK_MAX_TEXT_BYTES * 2)
    expect(splitForSlack(gorda)).toEqual([gorda])
  })

  it.each([0, -1, 1.5])('un tope de %s se rechaza', (maxBytes) => {
    expect(() => splitForSlack('hola', maxBytes)).toThrow(ValidationError)
  })
})

describe('los fallos se propagan', () => {
  it('un rechazo de Slack lanza', async () => {
    const { post } = poster([{ ok: false, status: 403 }])
    await expect(postToSlack({ webhookUrl: WEBHOOK, post }, 'hola')).rejects.toThrow(/403/)
  })

  it('y el mensaje de error NO lleva la URL, que es la credencial', async () => {
    const { post } = poster([{ ok: false, status: 500 }])
    const error = await postToSlack({ webhookUrl: WEBHOOK, post }, 'hola').catch((e: unknown) => e)
    expect((error as Error).message).not.toContain(WEBHOOK)
  })

  it('sin URL de webhook se lanza en vez de fingir que se aviso', async () => {
    await expect(postToSlack({ webhookUrl: '   ' }, 'hola')).rejects.toThrow(ValidationError)
  })
})

const AVISO: EscalationNotice = {
  taskRef: 'issue-42',
  destination: 'human',
  reason: 'Se han agotado los 2 intentos.',
  attempts: 2,
  maxAttempts: 2,
}

describe('como se ve un escalado', () => {
  it('lleva la tarea, el motivo y los intentos', async () => {
    const { post, enviados } = poster()
    await createSlackNotifier({ webhookUrl: WEBHOOK, post }).notifyEscalation(AVISO)

    const cuerpo = enviados[0]?.body ?? ''
    expect(cuerpo).toContain('issue-42')
    expect(cuerpo).toContain('agotado los 2 intentos')
    expect(cuerpo).toContain('2 de 2')
  })

  it('menciona al responsable cuando se sabe quien es', async () => {
    const { post, enviados } = poster()
    await createSlackNotifier({ webhookUrl: WEBHOOK, post }).notifyEscalation({
      ...AVISO,
      responsible: { kind: 'user', id: 'u1', label: 'Ana' },
      mention: 'U123',
    })
    expect(enviados[0]?.body).toContain('<@U123>')
  })

  it('sin mencion usa el nombre, y NO inventa un identificador de Slack', async () => {
    // Mencionar a quien no toca arrastra a un tercero a un hilo que no es suyo.
    const { post, enviados } = poster()
    await createSlackNotifier({ webhookUrl: WEBHOOK, post }).notifyEscalation({
      ...AVISO,
      responsible: { kind: 'user', id: 'u1', label: 'Ana' },
    })
    expect(enviados[0]?.body).toContain('Ana')
    expect(enviados[0]?.body).not.toContain('<@')
  })

  it('sin responsable lo dice con su motivo, en vez de callarse', async () => {
    const { post, enviados } = poster()
    await createSlackNotifier({ webhookUrl: WEBHOOK, post }).notifyEscalation({
      ...AVISO,
      unresolvedReason: 'el issue tiene 3 personas asignadas',
    })
    expect(enviados[0]?.body).toContain('Sin responsable')
    expect(enviados[0]?.body).toContain('3 personas asignadas')
  })

  it('el informe de conformidad NO viaja a Slack', async () => {
    // Es largo, vive mejor en el PR donde esta el codigo, y repetirlo aqui
    // invita a decidir desde el movil sin tener el diff a mano.
    const { post, enviados } = poster()
    await createSlackNotifier({ webhookUrl: WEBHOOK, post }).notifyEscalation({
      ...AVISO,
      reportMarkdown: '# Informe larguisimo\n\nCon todo el detalle',
    })
    expect(enviados[0]?.body).not.toContain('Informe larguisimo')
  })
})
