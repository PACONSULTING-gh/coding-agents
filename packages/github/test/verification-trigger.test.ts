import { ValidationError } from '@coord/core'
import { describe, expect, it } from 'vitest'

import type { GithubWebhookJob } from '../src/events.js'
import { decideVerificationTrigger } from '../src/verification-trigger.js'

/**
 * Cuando un pull request dispara una verificacion (epic 05).
 *
 * Lo que se fija: los tres casos en los que verificar SERIA CARO Y ABSURDO —un
 * borrador, algo ya cerrado, una accion que no cambia codigo— y la diferencia
 * entre "este PR no toca" y "el payload esta roto", que es lo que impide que un
 * cambio de forma en la API apague la verificacion en silencio.
 */

const SHA = 'a'.repeat(40)

function evento(overrides: Record<string, unknown> = {}, action = 'opened'): GithubWebhookJob {
  return {
    deliveryId: 'd-1',
    event: 'pull_request',
    action,
    installationId: 1,
    payload: {
      pull_request: {
        number: 42,
        state: 'open',
        draft: false,
        head: { sha: SHA },
        base: { ref: 'main' },
        ...overrides,
      },
      repository: { full_name: 'liberion-labs/crm' },
    },
  } as unknown as GithubWebhookJob
}

describe('cuando SI se verifica', () => {
  it.each(['opened', 'synchronize', 'reopened'])('accion %s', (action) => {
    const decision = decideVerificationTrigger(evento({}, action))
    expect(decision).toEqual({
      kind: 'verify',
      delivery: {
        number: 42,
        headSha: SHA,
        baseRef: 'main',
        repositoryFullName: 'liberion-labs/crm',
      },
    })
  })
})

describe('cuando verificar seria caro y absurdo', () => {
  it('un BORRADOR no se verifica', () => {
    // Un draft es trabajo que su autor dice que no esta listo. Verificarlo
    // produce un "no apto" merecido y completamente inutil, y ademas le gasta
    // uno de los dos intentos que tiene.
    expect(decideVerificationTrigger(evento({ draft: true }))).toEqual({
      kind: 'skip',
      reason: 'draft',
    })
  })

  it('un PR ya cerrado tampoco', () => {
    expect(decideVerificationTrigger(evento({ state: 'closed' }))).toEqual({
      kind: 'skip',
      reason: 'closed',
    })
  })

  it.each(['labeled', 'edited', 'assigned', 'review_requested'])(
    'la accion %s no cambia ni una linea',
    (action) => {
      // Verificar otra vez gastaria una llamada cara para llegar al mismo
      // veredicto sobre el mismo codigo.
      expect(decideVerificationTrigger(evento({}, action)).kind).toBe('skip')
    },
  )

  it('un evento que no es de pull request', () => {
    const job = { ...evento(), event: 'issues' } as unknown as GithubWebhookJob
    expect(decideVerificationTrigger(job)).toEqual({
      kind: 'skip',
      reason: 'not_a_pull_request_event',
    })
  })
})

describe('"no toca" y "el payload esta roto" son cosas distintas', () => {
  it('sin `pull_request` en el cuerpo, LANZA', () => {
    // Devolver `skip` haria que un cambio de forma en la API de GitHub se viera
    // como "es que nunca toca": la verificacion dejaria de funcionar entera y
    // el log diria que todo va bien.
    const job = {
      ...evento(),
      payload: { repository: { full_name: 'x/y' } },
    } as unknown as GithubWebhookJob
    expect(() => decideVerificationTrigger(job)).toThrow(ValidationError)
  })

  it.each([
    ['sin sha', { head: {} }],
    ['con un sha corto', { head: { sha: 'a1b2c3d' } }],
    ['con un sha que no es hex', { head: { sha: 'z'.repeat(40) } }],
  ])('%s, lanza', (_caso, overrides) => {
    // Sin SHA completo el informe no puede decir SOBRE QUE codigo se emitio, y
    // un informe que no dice a que se refiere sirve para aprobar cualquier cosa.
    expect(() => decideVerificationTrigger(evento(overrides))).toThrow(/SHA de cabeza/)
  })

  it('sin rama base, lanza', () => {
    expect(() => decideVerificationTrigger(evento({ base: {} }))).toThrow(/rama base/)
  })

  it.each([
    ['cero', 0],
    ['negativo', -3],
    ['decimal', 1.5],
    ['texto', '42'],
  ])('un numero de PR %s lanza', (_caso, number) => {
    expect(() => decideVerificationTrigger(evento({ number }))).toThrow(ValidationError)
  })

  it('sin repositorio, lanza', () => {
    const job = {
      ...evento(),
      payload: {
        pull_request: { number: 42, state: 'open', head: { sha: SHA }, base: { ref: 'main' } },
      },
    } as unknown as GithubWebhookJob
    expect(() => decideVerificationTrigger(job)).toThrow(/repositorio/)
  })
})
