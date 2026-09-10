import { ValidationError } from '@coord/core'
import { describe, expect, it, vi } from 'vitest'

import type { GithubWebhookJob } from '../src/events.js'
import {
  decideRoutingTrigger,
  runWithoutBlocking,
  type RoutingSkipReason,
} from '../src/routing-trigger.js'

/**
 * Cuando interviene el router y cuando no (T03 del epic 03, issue #33).
 *
 * Dos de los tres criterios de aceptacion se sostienen aqui: "un issue ya
 * asignado no se toca" y "el fallo del agente no bloquea a nadie". El tercero
 * —"en menos de 2 minutos aparece el comentario"— es sobre el sistema montado
 * y no se puede afirmar desde un test unitario.
 *
 * NADA DE ESTO SE HA EJERCITADO CONTRA GITHUB DE VERDAD: no hay ninguna GitHub
 * App registrada en ninguna maquina del proyecto. Los payloads de abajo tienen
 * la forma que documenta GitHub, y si esa forma cambia estos tests seguiran en
 * verde. Es la misma advertencia que lleva todo `packages/github`.
 */

function entrega(overrides: Partial<GithubWebhookJob> = {}): GithubWebhookJob {
  return {
    deliveryId: 'e1f2a3b4-0000-4000-8000-000000000001',
    event: 'issues',
    action: 'opened',
    installationId: 42,
    payload: {
      repository: { full_name: 'PACONSULTING-gh/coding-agents' },
      issue: {
        number: 77,
        title: 'El reintento de cobro duplica el cargo',
        body: 'Reportado por dos clientes.',
        assignees: [],
      },
    },
    ...overrides,
  }
}

/** La misma entrega, cambiando solo campos del objeto `issue`. */
function conIssue(cambios: Record<string, unknown>): GithubWebhookJob {
  const base = entrega()
  const issue = base.payload['issue'] as Record<string, unknown>
  return { ...base, payload: { ...base.payload, issue: { ...issue, ...cambios } } }
}

describe('un issue nuevo y sin dueño dispara el routing', () => {
  it('extrae lo minimo para poder sugerir: numero, titulo, cuerpo y repositorio', () => {
    const decision = decideRoutingTrigger(entrega())

    expect(decision).toEqual({
      kind: 'route',
      issue: {
        number: 77,
        title: 'El reintento de cobro duplica el cargo',
        body: 'Reportado por dos clientes.',
        repositoryFullName: 'PACONSULTING-gh/coding-agents',
      },
    })
  })

  it('un cuerpo ausente y uno vacio son lo mismo para quien lo lee', () => {
    // GitHub manda `null`, no `""`. Normalizarlo aqui evita que cada llamante
    // tenga que acordarse.
    for (const body of [null, '', '   ', undefined]) {
      const decision = decideRoutingTrigger(conIssue({ body }))
      expect(decision.kind).toBe('route')
      if (decision.kind !== 'route') throw new Error('deberia enrutar')
      expect(decision.issue.body).toBeUndefined()
    }
  })
})

describe('cuando NO interviene, y por que', () => {
  const casos: readonly (readonly [string, GithubWebhookJob, RoutingSkipReason])[] = [
    ['otro evento', entrega({ event: 'push', action: null }), 'not_an_issue_event'],
    // El criterio de aceptacion literal: quien asigna al abrir ya ha decidido.
    ['ya tiene asignado', conIssue({ assignees: [{ login: 'ana' }] }), 'already_assigned'],
    // `assignee` en singular esta deprecado pero GitHub lo sigue mandando, y
    // hay entregas con el relleno y `assignees` vacio. Mirar solo el plural
    // haria comentar en issues que SI tienen dueño.
    [
      'asignado por el campo deprecado',
      conIssue({ assignee: { login: 'ana' } }),
      'already_assigned',
    ],
    // Un PR ya tiene autor: sugerirle asignatarios no significa nada.
    [
      'es un pull request',
      conIssue({ pull_request: { url: 'https://api.github.test/pr/1' } }),
      'is_pull_request',
    ],
  ]

  it.each(casos)('%s', (_nombre, job, reason) => {
    expect(decideRoutingTrigger(job)).toEqual({ kind: 'skip', reason })
  })

  it.each(['edited', 'labeled', 'reopened', 'closed', 'assigned'])(
    'la accion "%s" no dispara nada: el shortlist se publica UNA vez, al abrirse',
    (action) => {
      // Comentar en cada edicion convierte la ayuda en ruido, y quien edita un
      // issue tres veces mientras lo redacta no quiere tres shortlists.
      expect(decideRoutingTrigger(entrega({ action }))).toEqual({
        kind: 'skip',
        reason: 'not_opened',
      })
    },
  )
})

describe('lo que NO cuenta como tener dueño', () => {
  it('`assignees: []` con `assignee: null` es un issue sin dueño', () => {
    // Es la forma normal en la que GitHub manda un issue recien abierto sin
    // asignar. Si se leyera como "tiene dueño", el router no intervendria nunca.
    expect(decideRoutingTrigger(conIssue({ assignees: [], assignee: null })).kind).toBe('route')
  })

  it('un `assignee` que no es un objeto no convierte a nadie en dueño', () => {
    // Un array vacio pasa `typeof === 'object'`: sin el guardia de `asRecord`,
    // un `assignee: []` bloquearia el routing de un issue que no tiene dueño.
    for (const assignee of [[], '', 0]) {
      expect(decideRoutingTrigger(conIssue({ assignee })).kind).toBe('route')
    }
  })

  it('`assignees` que no es un array se ignora, y manda el singular', () => {
    expect(decideRoutingTrigger(conIssue({ assignees: 'ana' })).kind).toBe('route')
  })
})

describe('un payload roto NO es "no toca"', () => {
  // Devolver `skip` aqui haria que un cambio de forma en la API de GitHub se
  // viera como "es que nunca toca": el routing dejaria de funcionar entero y el
  // log diria que todo va bien.
  it('un evento issues/opened sin `issue` lanza', () => {
    const roto = entrega()
    expect(() =>
      decideRoutingTrigger({ ...roto, payload: { repository: roto.payload['repository'] } }),
    ).toThrow(ValidationError)
  })

  it('un issue sin numero utilizable lanza', () => {
    for (const number of [undefined, 0, -1, 1.5, '77']) {
      // El mensaje dice QUE trajo, que es lo que permite diagnosticar sin
      // abrir la entrega.
      expect(() => decideRoutingTrigger(conIssue({ number }))).toThrow(/sin numero utilizable/)
    }
  })

  it('un issue sin titulo lanza, y el mensaje lo dice', () => {
    expect(() => decideRoutingTrigger(conIssue({ title: undefined }))).toThrow(/sin titulo/)
  })

  it('un `issue` que no es un objeto no se trata como si lo fuera', () => {
    // Un array pasa `typeof === 'object'` y no es null: sin el tercer guardia
    // de `asRecord`, `[]['number']` seria `undefined` y el error hablaria de un
    // numero que falta en vez de decir que el payload no tiene forma de issue.
    for (const issue of [[], 'un issue', 42, null]) {
      const base = entrega()
      expect(() => decideRoutingTrigger({ ...base, payload: { ...base.payload, issue } })).toThrow(
        /no trae `issue`/,
      )
    }
  })

  it('un `repository` que no es un objeto tampoco', () => {
    const base = entrega()
    for (const repository of [[], 'PACONSULTING-gh/coding-agents', null]) {
      expect(() =>
        decideRoutingTrigger({ ...base, payload: { ...base.payload, repository } }),
      ).toThrow(/repositorio/)
    }
  })

  it('un repositorio con el nombre vacio no vale', () => {
    const base = entrega()
    expect(() =>
      decideRoutingTrigger({
        ...base,
        payload: { ...base.payload, repository: { full_name: '' } },
      }),
    ).toThrow(/repositorio/)
  })

  it('una entrega que no dice de que repositorio viene lanza', () => {
    // Sin eso no se puede ni comentar el shortlist ni saber sobre que codigo se
    // esta sugiriendo.
    const base = entrega()
    expect(() =>
      decideRoutingTrigger({ ...base, payload: { issue: base.payload['issue'] } }),
    ).toThrow(/repositorio/)
  })

  it('el mensaje nombra la entrega, para poder ir a buscarla', () => {
    const base = entrega()
    expect(() => decideRoutingTrigger({ ...base, payload: {} })).toThrow(base.deliveryId)
  })
})

describe('el fallo del router no bloquea a nadie', () => {
  it('devuelve lo que produzca el trabajo cuando va bien, y no reporta nada', async () => {
    const report = vi.fn()

    await expect(runWithoutBlocking(() => Promise.resolve('shortlist'), report)).resolves.toBe(
      'shortlist',
    )
    expect(report).not.toHaveBeenCalled()
  })

  it('un fallo se reporta CON SU TIPO y no sube', async () => {
    // Si subiera, el job del webhook fallaria, se reintentaria y acabaria en la
    // cola de fallidos — por no haber podido sugerir un asignatario.
    const fallo = new ValidationError('el modelo devolvio algo que no encaja')
    const report = vi.fn()

    await expect(runWithoutBlocking(() => Promise.reject(fallo), report)).resolves.toBeUndefined()

    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0]?.[0]).toBe(fallo)
  })

  it('tragar es no dejar rastro: aqui SIEMPRE queda rastro', async () => {
    const vistos: unknown[] = []
    await runWithoutBlocking(
      () => Promise.reject(new Error('boom')),
      (e) => vistos.push(e),
    )
    expect(vistos).toHaveLength(1)
  })

  it('si ADEMAS falla el registro, sigue sin bloquear y queda el ultimo recurso', async () => {
    // No se puede prometer a la vez "nunca bloquea" y "siempre queda
    // registrado": si el registro falla —la base de datos caida, que es justo
    // cuando mas cosas fallan— hay que romper una de las dos. Se rompe la del
    // registro, que es la que no le estropea el dia a nadie.
    const consola = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(
        runWithoutBlocking(
          () => Promise.reject(new Error('el router se cayo')),
          () => {
            throw new Error('y el log tambien')
          },
        ),
      ).resolves.toBeUndefined()

      expect(consola).toHaveBeenCalledTimes(1)
      const escrito = consola.mock.calls[0]?.map(String).join(' ') ?? ''
      // Los dos errores, no solo el ultimo: sin el original no se puede
      // diagnosticar nada.
      expect(escrito).toContain('el router se cayo')
      expect(escrito).toContain('y el log tambien')
    } finally {
      consola.mockRestore()
    }
  })

  it('un fallo sincrono al construir el trabajo tampoco sube', async () => {
    // `work` puede petar antes de devolver la promesa (un `throw` en la primera
    // linea). Si eso no estuviera dentro del `try`, bloquearia igual.
    const report = vi.fn()
    await expect(
      runWithoutBlocking(() => {
        throw new Error('petó antes de empezar')
      }, report),
    ).resolves.toBeUndefined()
    expect(report).toHaveBeenCalledTimes(1)
  })
})
