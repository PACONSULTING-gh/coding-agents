import { describe, expect, it } from 'vitest'

import {
  extractAction,
  extractInstallationId,
  parseInstallationDescriptor,
} from '../src/installations.js'

/**
 * El payload lo manda GitHub, pero lo recibe un endpoint publico: es frontera
 * de confianza y se comprueba campo a campo. Estos casos cubren tanto la forma
 * buena como las formas rotas que un atacante puede fabricar.
 */

const INSTALLATION_PAYLOAD = {
  action: 'suspend',
  installation: {
    id: 987_654,
    account: { login: 'PACONSULTING-gh', type: 'Organization' },
    repository_selection: 'selected',
    suspended_at: '2026-09-08T10:00:00Z',
  },
}

describe('extractInstallationId', () => {
  it('devuelve el id cuando el payload lo trae', () => {
    expect(extractInstallationId(INSTALLATION_PAYLOAD)).toBe(987_654)
  })

  it('devuelve undefined cuando no hay instalacion (por ejemplo un ping)', () => {
    expect(extractInstallationId({ zen: 'Keep it logically awesome.' })).toBeUndefined()
    expect(extractInstallationId({ installation: null })).toBeUndefined()
    expect(extractInstallationId(null)).toBeUndefined()
    expect(extractInstallationId('no soy un objeto')).toBeUndefined()
  })

  it('no acepta ids que no sean enteros positivos', () => {
    expect(extractInstallationId({ installation: { id: '123' } })).toBeUndefined()
    expect(extractInstallationId({ installation: { id: 0 } })).toBeUndefined()
    expect(extractInstallationId({ installation: { id: -1 } })).toBeUndefined()
    expect(extractInstallationId({ installation: { id: 1.5 } })).toBeUndefined()
  })
})

describe('extractAction', () => {
  it('devuelve la accion, o null si el evento no la trae', () => {
    expect(extractAction(INSTALLATION_PAYLOAD)).toBe('suspend')
    expect(extractAction({ ref: 'refs/heads/main' })).toBeNull()
    expect(extractAction({ action: '' })).toBeNull()
    expect(extractAction({ action: 42 })).toBeNull()
  })
})

describe('parseInstallationDescriptor', () => {
  it('extrae el estado completo de la instalacion', () => {
    expect(parseInstallationDescriptor(INSTALLATION_PAYLOAD)).toEqual({
      installationId: 987_654,
      accountLogin: 'PACONSULTING-gh',
      accountType: 'Organization',
      repositorySelection: 'selected',
      suspendedAt: new Date('2026-09-08T10:00:00Z'),
    })
  })

  it('suspended_at ausente significa no suspendida', () => {
    const payload = {
      installation: {
        id: 1,
        account: { login: 'liberion', type: 'Organization' },
        repository_selection: 'all',
        suspended_at: null,
      },
    }
    expect(parseInstallationDescriptor(payload).suspendedAt).toBeNull()
  })

  it('rechaza payloads incompletos o con tipos de cuenta no soportados', () => {
    expect(() => parseInstallationDescriptor({})).toThrow(/no contiene el objeto/i)
    expect(() =>
      parseInstallationDescriptor({
        installation: { id: 1, account: { login: 'x', type: 'Bot' } },
      }),
    ).toThrow(/tipo de cuenta/i)
    expect(() =>
      parseInstallationDescriptor({
        installation: {
          id: 1,
          account: { login: 'x', type: 'User' },
          repository_selection: 'todos',
        },
      }),
    ).toThrow(/repository_selection/i)
    expect(() =>
      parseInstallationDescriptor({
        installation: { id: 1, account: { type: 'User' }, repository_selection: 'all' },
      }),
    ).toThrow(/account\.login/i)
  })

  it('rechaza una fecha de suspension invalida en vez de guardarla', () => {
    expect(() =>
      parseInstallationDescriptor({
        installation: {
          id: 1,
          account: { login: 'x', type: 'User' },
          repository_selection: 'all',
          suspended_at: 'ayer por la tarde',
        },
      }),
    ).toThrow(/suspended_at/i)
  })
})
