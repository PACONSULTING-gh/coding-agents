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

  it('cuando hay MOTIVO, el aviso lo dice en vez de afirmar algo generico', () => {
    // El caso que obliga a que exista este campo: con tres co-asignados, decir
    // "no hay assignee en el issue" seria FALSO. Un aviso que afirma algo que
    // no es cierto es peor que uno escueto, porque quien lo lee actua sobre el.
    const texto = renderEscalationComment({
      ...BASE,
      unresolvedReason:
        'No hay claim activo sobre issue-42 y el issue tiene 3 personas asignadas ' +
        '(ana, bruno, carla), asi que ninguna es "la" responsable',
    })

    expect(texto).toContain('3 personas asignadas')
    expect(texto).toContain('ana, bruno, carla')
    expect(texto).toContain('alguien tiene que hacerse cargo')
    // Y sigue sin mencionar a nadie: nombrarlos no es elegir a uno.
    expect(texto).not.toContain('@ana')
  })

  it('sin motivo NO se inventa uno concreto', () => {
    // El respaldo dice que no se sabe, no "no hay assignee": afirmar la causa
    // sin haberla comprobado es la misma mentira, solo que por defecto.
    const texto = renderEscalationComment(BASE)
    expect(texto).toContain('No se ha podido determinar quien responde')
    expect(texto).not.toContain('assignee')
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

describe('a que issue va el comentario', () => {
  /**
   * Un doble de la App que captura la llamada. Sin esto, el camino de
   * publicacion —incluida la traduccion de `taskRef` a numero de issue— solo
   * estaba probado por su rama de error, y un aviso que va al issue equivocado
   * es peor que uno que no sale: aparece resuelto y no lo esta.
   */
  function appQueCaptura() {
    const llamadas: { owner: string; repo: string; issue_number: number; body: string }[] = []
    const app = {
      getInstallationOctokit: () =>
        Promise.resolve({
          rest: {
            issues: {
              createComment: (args: {
                owner: string
                repo: string
                issue_number: number
                body: string
              }) => {
                llamadas.push(args)
                return Promise.resolve({ data: { id: 1, html_url: 'https://example.test/c/1' } })
              },
            },
          },
        }),
    }
    return { app, llamadas }
  }

  it.each([
    ['issue-42', 42],
    ['42', 42],
    ['  issue-7  ', 7],
  ])('%s se publica en el issue %i', async (taskRef, esperado) => {
    const { app, llamadas } = appQueCaptura()
    const notifier = new GitHubEscalationNotifier(app as never, {
      installationId: 9,
      owner: 'PACONSULTING-gh',
      repo: 'coding-agents',
    })

    await notifier.notifyEscalation({ ...BASE, taskRef })

    expect(llamadas).toHaveLength(1)
    expect(llamadas[0]?.issue_number).toBe(esperado)
    expect(llamadas[0]?.owner).toBe('PACONSULTING-gh')
    expect(llamadas[0]?.repo).toBe('coding-agents')
    expect(llamadas[0]?.body).toContain(BASE.reason)
  })

  it.each(['42-issue', 'issue-', 'issue-4a', 'pr-42'])(
    '%s no se publica en ningun sitio: se lanza',
    async (taskRef) => {
      // Publicar "por si acaso" en un numero deducido a medias seria comentar
      // en un issue de otra persona.
      const { app, llamadas } = appQueCaptura()
      const notifier = new GitHubEscalationNotifier(app as never, {
        installationId: 9,
        owner: 'o',
        repo: 'r',
      })

      await expect(notifier.notifyEscalation({ ...BASE, taskRef })).rejects.toThrow(ValidationError)
      expect(llamadas).toEqual([])
    },
  )

  it('sin commit verificado no se escribe la linea con un undefined dentro', () => {
    const texto = renderEscalationComment(BASE)
    expect(texto).not.toContain('Commit verificado')
    expect(texto).not.toContain('undefined')
  })

  it('la mencion se limpia de espacios antes de la arroba', () => {
    const texto = renderEscalationComment({
      ...BASE,
      responsible: { kind: 'user', id: 'u-1', label: 'Javier' },
      mention: '  JVISERASS  ',
    })
    expect(texto).toContain('@JVISERASS ')
    expect(texto).not.toContain('@  ')
  })
})
