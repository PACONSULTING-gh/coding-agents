import { ValidationError, type EscalationNotice } from '@coord/core'
import { describe, expect, it } from 'vitest'

import {
  GitHubEscalationNotifier,
  renderEscalationComment,
} from '../src/escalation-notification.js'

/**
 * El aviso de escalado (T06, ADR 0008), sin red.
 *
 * Lo que se comprueba aqui es el TEXTO, porque es lo unico que va a leer la
 * persona a la que se escala. La publicacion contra la API ya la cubre
 * `pull-request-comments.test.ts` contra un servidor local.
 */

const BASE: EscalationNotice = {
  taskRef: 'issue-42',
  destination: 'human',
  reason: 'El gate determinista fallo y se han agotado los 2 intentos.',
  attempts: 2,
  maxAttempts: 2,
}

describe('a quien va dirigido', () => {
  it('menciona cuando quien resolvio al responsable aporta la mencion', () => {
    const texto = renderEscalationComment({
      ...BASE,
      responsible: { kind: 'user', id: 'u-1', label: 'Javier' },
      mention: 'JVISERASS',
    })
    expect(texto).toContain('@JVISERASS')
    expect(texto).toContain('Javier')
  })

  it('NO adivina la mencion a partir del id, aunque el id parezca un login', () => {
    // REGRESION. Esto se intentaba deducir con `^[A-Za-z0-9-]{1,39}$`, y un
    // UUID pasa ese filtro tan campante: se mencionaba a quien no tocaba.
    // Informar sin mencionar es mejor que mencionar mal.
    const texto = renderEscalationComment({
      ...BASE,
      responsible: { kind: 'user', id: '9f1c2b3a-0000-4000-8000-000000000000', label: 'Javier' },
    })
    expect(texto).not.toContain('@')
    expect(texto).toContain('Javier')
  })

  it('NO menciona a un agente cuando nadie aporta mencion', () => {
    const texto = renderEscalationComment({
      ...BASE,
      responsible: { kind: 'agent', id: 'claude-1', label: 'Claude worker 1' },
    })
    expect(texto).not.toContain('@')
    expect(texto).toContain('Claude worker 1')
  })

  it('una mencion vacia o en blanco cuenta como no haberla', () => {
    const texto = renderEscalationComment({
      ...BASE,
      responsible: { kind: 'user', id: 'u-1', label: 'Javier' },
      mention: '   ',
    })
    expect(texto).not.toContain('@')
  })

  it('cuando no hay responsable, lo DICE en vez de elegir a alguien', () => {
    // Una tarea que falla y no tiene dueño es en si misma un hallazgo. Elegir a
    // alguien plausible lo convierte en un mensaje que se ignora por no ir con
    // quien lo recibe.
    const texto = renderEscalationComment(BASE)
    expect(texto).toContain('Sin responsable identificado')
    expect(texto).toContain('alguien tiene que hacerse cargo')
    expect(texto).not.toContain('@')
  })
})

describe('que se cuenta en el aviso', () => {
  it('lleva el motivo, los intentos y el commit verificado', () => {
    const texto = renderEscalationComment({ ...BASE, headSha: 'a'.repeat(40) })

    expect(texto).toContain('El gate determinista fallo')
    expect(texto).toContain('**Intentos:** 2 de 2')
    // Sin el SHA, un aviso pegado a un issue al que despues se le empujan
    // commits no dice a que entrega se refiere.
    expect(texto).toContain('a'.repeat(40))
  })

  it('el titulo distingue escalar a una persona de volver a criterios', () => {
    // No es cosmetico: quien lo lee tiene que saber de un vistazo si le toca
    // revisar codigo o reescribir un criterio.
    expect(renderEscalationComment(BASE)).toContain('escalada a una persona')
    expect(renderEscalationComment({ ...BASE, destination: 'criteria_phase' })).toContain(
      'De vuelta a la fase de criterios',
    )
  })

  it('adjunta el informe de conformidad cuando lo hay', () => {
    const texto = renderEscalationComment({
      ...BASE,
      reportMarkdown: '## Informe de conformidad — issue-42',
    })
    expect(texto).toContain('## Informe de conformidad — issue-42')
  })

  it('sin informe no deja un separador colgando', () => {
    expect(renderEscalationComment(BASE)).not.toContain('---')
  })
})

describe('una tarea sin issue no se puede avisar por este canal', () => {
  it('lanza en vez de tragarselo', async () => {
    // Un aviso que no llega a ninguna parte es peor que un error: nadie se
    // entera de que nadie se entero. `taskRef` admite slugs de la fase de
    // diseño, anteriores al issue.
    const notifier = new GitHubEscalationNotifier({} as never, {
      installationId: 1,
      owner: 'o',
      repo: 'r',
    })

    await expect(
      notifier.notifyEscalation({ ...BASE, taskRef: 'diseño-del-router' }),
    ).rejects.toThrow(ValidationError)
    await expect(
      notifier.notifyEscalation({ ...BASE, taskRef: 'diseño-del-router' }),
    ).rejects.toThrow(/un aviso que no llega no se puede dar por enviado/i)
  })
})
