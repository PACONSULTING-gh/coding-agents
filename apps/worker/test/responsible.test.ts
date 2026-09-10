import type { Claim } from '@coord/core'
import { ValidationError } from '@coord/core'
import { describe, expect, it, vi } from 'vitest'

import { resolveResponsible, type ResolveResponsibleDeps } from '../src/responsible.js'

/**
 * La cadena de responsable del ADR 0008 (decision 4): holder del claim ->
 * assignee del issue -> nadie.
 *
 * Lo que se fija aqui es el ORDEN y, sobre todo, CUANDO NO SE ELIGE A NADIE.
 * Es el sitio donde es facil colar una mejora que en realidad es una mentira:
 * rellenar el hueco con alguien plausible para que el aviso "quede mejor".
 */

const REPO_ID = '11111111-1111-4111-8111-111111111111'

function claimSobreIssue(overrides: Partial<Claim> = {}): Claim {
  return {
    claimId: 'c1',
    groupId: 'g1',
    repoId: REPO_ID,
    subject: { kind: 'issue', key: '42' },
    holder: { kind: 'user', id: 'u-77', label: 'Ana' },
    claimedAt: new Date('2026-09-10T10:00:00Z'),
    expiresAt: new Date('2026-09-10T18:00:00Z'),
    releasedAt: null,
    releasedReason: null,
    metadata: {},
    ...overrides,
  }
}

function deps(overrides: Partial<ResolveResponsibleDeps> = {}): ResolveResponsibleDeps {
  return {
    activeIssueClaims: vi.fn(() => Promise.resolve([])),
    issueAssignees: vi.fn(() => Promise.resolve([])),
    ...overrides,
  }
}

describe('el orden de la cadena', () => {
  it('el claim activo gana, y ni se pregunta por el assignee', async () => {
    // Preguntar de todas formas seria una llamada de red por cada verificacion
    // fallida cuyo resultado se tira. Y peor: si GitHub fallara, un claim
    // perfectamente valido se quedaria sin resolver.
    const issueAssignees = vi.fn(() => Promise.resolve(['bruno']))
    const resolucion = await resolveResponsible(
      { taskRef: 'issue-42', repoId: REPO_ID },
      deps({ activeIssueClaims: () => Promise.resolve([claimSobreIssue()]), issueAssignees }),
    )

    expect(resolucion).toEqual({ source: 'claim', responsible: claimSobreIssue().holder })
    expect(issueAssignees).not.toHaveBeenCalled()
  })

  it('un taskRef con espacios alrededor sigue siendo el mismo issue', async () => {
    // Sin recortar, " issue-42 " no casaria con el ancla y la tarea se trataria
    // como un slug de diseño: nunca se preguntaria por el assignee y el aviso
    // diria que no hay responsable habiendolo.
    const issueAssignees = vi.fn(() => Promise.resolve(['bruno']))
    const resolucion = await resolveResponsible(
      { taskRef: '  issue-42  ', repoId: REPO_ID },
      deps({ issueAssignees }),
    )

    expect(issueAssignees).toHaveBeenCalledWith(42)
    expect(resolucion.source).toBe('issue_assignee')
  })

  it('sin claim, se cae al assignee del issue', async () => {
    const resolucion = await resolveResponsible(
      { taskRef: 'issue-42', repoId: REPO_ID },
      deps({ issueAssignees: () => Promise.resolve(['bruno']) }),
    )

    expect(resolucion).toEqual({
      source: 'issue_assignee',
      responsible: { kind: 'user', id: 'bruno', label: 'bruno' },
      mention: 'bruno',
    })
  })

  it('un claim que NO es sobre el issue no cuenta', async () => {
    // Un claim de fichero dice quien esta tocando un fichero, no quien responde
    // de la tarea. Tomarlo por responsable señalaria a alguien que quiza solo
    // pasaba por ahi.
    const deFichero = claimSobreIssue({ subject: { kind: 'file', key: 'src/a.ts' } })
    const resolucion = await resolveResponsible(
      { taskRef: 'issue-42', repoId: REPO_ID },
      deps({
        activeIssueClaims: () => Promise.resolve([deFichero]),
        issueAssignees: () => Promise.resolve(['bruno']),
      }),
    )

    expect(resolucion.source).toBe('issue_assignee')
  })
})

describe('la mencion: solo cuando la fuente garantiza un login', () => {
  it('por assignee siempre, porque `login` ES el login', async () => {
    const resolucion = await resolveResponsible(
      { taskRef: '42', repoId: REPO_ID },
      deps({ issueAssignees: () => Promise.resolve(['bruno']) }),
    )
    expect(resolucion).toMatchObject({ mention: 'bruno' })
  })

  it('por claim NO, aunque el id parezca un login', async () => {
    // Este es el fallo que ya se cometio una vez: un UUID pasa por login
    // valido, y mencionar a quien no toca arrastra a un tercero a un hilo que
    // no es suyo. El aviso nombra por `label` y no menciona a nadie.
    const resolucion = await resolveResponsible(
      { taskRef: 'issue-42', repoId: REPO_ID },
      deps({
        activeIssueClaims: () =>
          Promise.resolve([
            claimSobreIssue({ holder: { kind: 'user', id: 'ana-lopez', label: 'Ana López' } }),
          ]),
      }),
    )

    expect(resolucion).not.toHaveProperty('mention')
  })

  it('por claim SI, si el claim dejo escrito el login', async () => {
    const resolucion = await resolveResponsible(
      { taskRef: 'issue-42', repoId: REPO_ID },
      deps({
        activeIssueClaims: () =>
          Promise.resolve([claimSobreIssue({ metadata: { githubLogin: 'ana' } })]),
      }),
    )

    expect(resolucion).toMatchObject({ source: 'claim', mention: 'ana' })
  })

  it.each([['  '], [42], [null], [{ login: 'ana' }]])(
    'un `githubLogin` que no es un login usable (%s) se ignora en vez de usarse',
    async (githubLogin) => {
      const resolucion = await resolveResponsible(
        { taskRef: 'issue-42', repoId: REPO_ID },
        deps({
          activeIssueClaims: () =>
            Promise.resolve([claimSobreIssue({ metadata: { githubLogin } })]),
        }),
      )

      expect(resolucion).not.toHaveProperty('mention')
    },
  )
})

describe('cuando NO se elige a nadie, y por que', () => {
  it('sin claim y sin assignee: se dice que la tarea no tiene dueño', async () => {
    const resolucion = await resolveResponsible({ taskRef: 'issue-42', repoId: REPO_ID }, deps())

    expect(resolucion.source).toBe('none')
    if (resolucion.source !== 'none') throw new Error('inalcanzable')
    expect(resolucion.unresolvedReason).toContain('ni nadie asignado al issue')
  })

  it('VARIOS co-asignados: no se elige al primero, y el motivo los nombra', async () => {
    // GitHub no ordena los assignees por responsabilidad, asi que "el primero"
    // es arbitrario. Y decir "no hay assignee" seria FALSO: hay tres. El aviso
    // tiene que poder decir la verdad.
    const resolucion = await resolveResponsible(
      { taskRef: 'issue-42', repoId: REPO_ID },
      deps({ issueAssignees: () => Promise.resolve(['ana', 'bruno', 'carla']) }),
    )

    expect(resolucion.source).toBe('none')
    if (resolucion.source !== 'none') throw new Error('inalcanzable')
    expect(resolucion.unresolvedReason).toContain('3 personas asignadas')
    expect(resolucion.unresolvedReason).toContain('ana, bruno, carla')
  })

  it.each([
    ['diseno-42-flujo', 'un slug que LLEVA un numero dentro'],
    ['42-primera-fase', 'un slug que EMPIEZA por numero'],
    ['epic-05-t06', 'un slug con varios numeros'],
  ])('%s (%s) NO se toma por un issue', async (taskRef) => {
    // Lo delata el mutation testing: sin el ancla `^...$`, "diseno-42-flujo"
    // casaria y saldria a preguntarle a GitHub por el issue 42 — que existe y
    // es de otra persona. Sacar un responsable de ahi seria peor que no sacar
    // ninguno, porque nadie sabria que la referencia estaba mal.
    const issueAssignees = vi.fn(() => Promise.resolve(['bruno']))
    const resolucion = await resolveResponsible(
      { taskRef, repoId: REPO_ID },
      deps({ issueAssignees }),
    )

    expect(issueAssignees).not.toHaveBeenCalled()
    expect(resolucion.source).toBe('none')
  })

  it('una tarea sin numero de issue no consulta a GitHub, y lo dice', async () => {
    // En la fase de diseño la tarea es un slug y todavia no hay issue. No es un
    // error: es el final de la cadena.
    const issueAssignees = vi.fn(() => Promise.resolve(['bruno']))
    const resolucion = await resolveResponsible(
      { taskRef: 'diseno-flujo-de-fallo', repoId: REPO_ID },
      deps({ issueAssignees }),
    )

    expect(issueAssignees).not.toHaveBeenCalled()
    if (resolucion.source !== 'none') throw new Error('inalcanzable')
    expect(resolucion.unresolvedReason).toContain('no tiene numero de issue')
  })
})

describe('el invariante roto se reporta, no se apaña', () => {
  it('dos claims vivos sobre el mismo issue LANZAN', async () => {
    // `claim()` lo impide dentro de un repo. Si aun asi llegan dos, elegir uno
    // taparia el fallo con una decision inventada.
    await expect(
      resolveResponsible(
        { taskRef: 'issue-42', repoId: REPO_ID },
        deps({
          activeIssueClaims: () =>
            Promise.resolve([
              claimSobreIssue(),
              claimSobreIssue({
                claimId: 'c2',
                holder: { kind: 'user', id: 'u-9', label: 'Bruno' },
              }),
            ]),
        }),
      ),
    ).rejects.toThrow(ValidationError)
  })

  it.each([
    ['taskRef vacio', { taskRef: '', repoId: REPO_ID }],
    ['taskRef solo espacios', { taskRef: '  ', repoId: REPO_ID }],
    ['repoId vacio', { taskRef: 'issue-42', repoId: '' }],
    // Un repoId de espacios llegaria a la consulta y devolveria cero claims:
    // la cadena seguiria al assignee y elegiria responsable como si el issue
    // no estuviera reclamado. Un fallo silencioso, que es el peor.
    ['repoId solo espacios', { taskRef: 'issue-42', repoId: '   ' }],
  ])('%s se rechaza', async (_caso, input) => {
    await expect(resolveResponsible(input, deps())).rejects.toThrow(ValidationError)
  })
})

describe('la consulta de claims va acotada al repo', () => {
  it('se le pasa el repoId, porque el mismo numero de issue existe en varios repos', async () => {
    // Sin acotar, el issue 42 de otro proyecto elegiria responsable en este.
    const activeIssueClaims = vi.fn(() => Promise.resolve([]))
    await resolveResponsible({ taskRef: 'issue-42', repoId: REPO_ID }, deps({ activeIssueClaims }))

    expect(activeIssueClaims).toHaveBeenCalledWith({ taskRef: 'issue-42', repoId: REPO_ID })
  })
})
