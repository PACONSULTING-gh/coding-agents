import { describe, expect, it } from 'vitest'

import type { Claim } from './claims.js'
import {
  confidenceFor,
  crossWithClaims,
  DEFAULT_MIN_CONFIDENCE,
  mergePredictions,
  type PredictionEvidence,
} from './collision-prediction.js'
import { ValidationError } from './errors.js'

/**
 * La prediccion de afectados y su cruce con los claims (epic 04 / T04).
 *
 * Lo que se fija aqui, por orden de importancia:
 *   1. Que esto AVISA y no puede bloquear — ni siquiera por accidente.
 *   2. Que cada fichero dice por que esta, y si esta por dos razones, las dos.
 *   3. Que la confianza se deriva de algo, no se inventa.
 */

const AHORA = new Date('2026-09-13T12:00:00Z')

function claimDe(path: string, holderId: string, label: string): Claim {
  return {
    claimId: `c-${path}`,
    groupId: 'g1',
    repoId: 'r1',
    subject: { kind: 'file', key: path },
    holder: { kind: 'user', id: holderId, label },
    claimedAt: AHORA,
    expiresAt: new Date(AHORA.getTime() + 3_600_000),
    releasedAt: null,
    releasedReason: null,
    metadata: {},
  }
}

describe('cada fichero dice por que esta', () => {
  it('si esta por DOS razones, se guardan las dos', () => {
    // "Lo importa el fichero de la tarea Y ADEMAS cambia con el historicamente"
    // es mucho mas creible que cualquiera de las dos sola. Quedarse con la mas
    // fuerte lo esconde.
    const fundidos = mergePredictions({
      candidates: [
        { path: 'src/pagos.ts', evidence: { source: 'import', hops: 1, via: 'src/api.ts' } },
        { path: 'src/pagos.ts', evidence: { source: 'cochange', together: 9 } },
      ],
    })

    expect(fundidos).toHaveLength(1)
    expect(fundidos[0]?.evidence.map((e) => e.source).sort()).toEqual(['cochange', 'import'])
  })

  it('un fichero sin ninguna evidencia no se puede justificar: lanza', () => {
    expect(() => confidenceFor([])).toThrow(ValidationError)
  })

  it('la evidencia conserva CON QUE se relaciona, que es lo que lo hace leible', () => {
    const fundidos = mergePredictions({
      candidates: [{ path: 'src/b.ts', evidence: { source: 'import', hops: 2, via: 'src/a.ts' } }],
    })
    expect(fundidos[0]?.evidence[0]).toMatchObject({ via: 'src/a.ts', hops: 2 })
  })
})

describe('la confianza se deriva, no se inventa', () => {
  it('una semilla vale mas que un import DIRECTO, y ese mas que un co-cambio', () => {
    // Este test se escribio con el nombre correcto y una asercion que decia lo
    // CONTRARIO, y pasaba en verde: el modelo descontaba ya el primer salto,
    // asi que un import directo quedaba por debajo de un co-cambio historico.
    // El nombre tenia razon y el codigo no.
    const semilla = confidenceFor([{ source: 'seed', hops: 0 }])
    const importado = confidenceFor([{ source: 'import', hops: 1 }])
    const coCambio = confidenceFor([{ source: 'cochange' }])

    expect(semilla).toBeGreaterThan(importado)
    expect(importado).toBeGreaterThan(coCambio)
  })

  it('un import a DOS saltos si cae por debajo de un co-cambio', () => {
    // El descuento sigue existiendo: lo que se quito es que penalizara la
    // primera arista, que es la mas firme que hay despues de la semilla.
    expect(confidenceFor([{ source: 'import', hops: 2 }])).toBeLessThan(
      confidenceFor([{ source: 'cochange' }]),
    )
  })

  it('cada salto en el grafo descuenta', () => {
    const cerca = confidenceFor([{ source: 'import', hops: 1 }])
    const lejos = confidenceFor([{ source: 'import', hops: 3 }])
    expect(lejos).toBeLessThan(cerca)
  })

  it('cinco co-cambios flojos NO adelantan a un import directo', () => {
    // Sumarlas todas por igual seria exactamente al reves de lo que dice el
    // grafo: la evidencia mas fuerte manda y las demas suman poco.
    const muchosFlojos: PredictionEvidence[] = Array.from({ length: 5 }, () => ({
      source: 'cochange' as const,
    }))
    expect(confidenceFor(muchosFlojos)).toBeLessThan(confidenceFor([{ source: 'seed', hops: 0 }]))
  })

  it('nunca pasa de 1', () => {
    const todas: PredictionEvidence[] = [
      { source: 'seed', hops: 0 },
      { source: 'import', hops: 0 },
      { source: 'call', hops: 0 },
      { source: 'cochange' },
    ]
    expect(confidenceFor(todas)).toBeLessThanOrEqual(1)
  })
})

describe('lo que no llega al umbral no se enseña', () => {
  it('un co-cambio a muchos saltos se queda fuera', () => {
    // Un aviso con cuarenta ficheros al 0,05 no lo lee nadie, y a la tercera
    // vez deja de leerse tambien la parte buena.
    const fundidos = mergePredictions({
      candidates: [
        { path: 'src/a.ts', evidence: { source: 'seed', hops: 0 } },
        { path: 'src/lejano.ts', evidence: { source: 'call', hops: 6 } },
      ],
    })

    expect(fundidos.map((f) => f.path)).toEqual(['src/a.ts'])
  })

  it('el umbral se puede bajar por llamada', () => {
    const fundidos = mergePredictions({
      candidates: [{ path: 'src/lejano.ts', evidence: { source: 'call', hops: 6 } }],
      minConfidence: 0,
    })
    expect(fundidos).toHaveLength(1)
  })

  it.each([-0.1, 1.5])('un umbral de %s se rechaza', (minConfidence) => {
    expect(() => mergePredictions({ candidates: [], minConfidence })).toThrow(ValidationError)
  })

  it('el orden es estable: misma entrada, mismo orden', () => {
    // Una prediccion que cambia de orden entre dos ejecuciones identicas no se
    // puede revisar.
    const candidates = [
      { path: 'src/b.ts', evidence: { source: 'import' as const, hops: 1 } },
      { path: 'src/a.ts', evidence: { source: 'import' as const, hops: 1 } },
    ]
    expect(mergePredictions({ candidates }).map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('una ruta vacia se descarta en vez de colarse como fichero', () => {
    expect(
      mergePredictions({ candidates: [{ path: '   ', evidence: { source: 'seed' } }] }),
    ).toEqual([])
  })
})

describe('el cruce con los claims AVISA, y no puede bloquear', () => {
  const predicted = mergePredictions({
    candidates: [
      { path: 'src/pagos.ts', evidence: { source: 'seed', hops: 0 } },
      { path: 'src/api.ts', evidence: { source: 'import', hops: 1 } },
    ],
  })

  it('un fichero reclamado por OTRA persona sale como solape', () => {
    const aviso = crossWithClaims({
      predicted,
      activeClaims: [claimDe('src/pagos.ts', 'u-bruno', 'Bruno')],
      holderId: 'u-ana',
    })

    expect(aviso.overlaps).toHaveLength(1)
    expect(aviso.overlaps[0]?.heldBy.label).toBe('Bruno')
    // Y el solape arrastra POR QUE se predijo ese fichero: sin eso, el aviso
    // dice "chocas" y no se puede juzgar si la prediccion tenia sentido.
    expect(aviso.overlaps[0]?.evidence[0]?.source).toBe('seed')
  })

  it('los claims PROPIOS no son una colision', () => {
    // Si contaran, el aviso diria que chocas contigo mismo, y a la segunda vez
    // nadie lo lee.
    const aviso = crossWithClaims({
      predicted,
      activeClaims: [claimDe('src/pagos.ts', 'u-ana', 'Ana')],
      holderId: 'u-ana',
    })
    expect(aviso.overlaps).toEqual([])
  })

  it('un claim sobre el ISSUE no cuenta como solape de ficheros', () => {
    // Dice quien lleva la tarea, no que ficheros toca. Contarlo marcaria
    // colision con cualquiera que tenga un issue abierto.
    const deIssue: Claim = {
      ...claimDe('x', 'u-bruno', 'Bruno'),
      subject: { kind: 'issue', key: 'src/pagos.ts' },
    }
    expect(
      crossWithClaims({ predicted, activeClaims: [deIssue], holderId: 'u-ana' }).overlaps,
    ).toEqual([])
  })

  it('el resumen dice que es un AVISO y que puede equivocarse', () => {
    const aviso = crossWithClaims({
      predicted,
      activeClaims: [claimDe('src/pagos.ts', 'u-bruno', 'Bruno')],
      holderId: 'u-ana',
    })

    expect(aviso.summary).toContain('AVISO, no bloqueo')
    expect(aviso.summary).toContain('experimental')
    expect(aviso.summary).toContain('Bruno')
  })

  it('sin solapes tambien lo dice, en vez de callarse', () => {
    const aviso = crossWithClaims({ predicted, activeClaims: [], holderId: 'u-ana' })
    expect(aviso.summary).toContain('ninguno pisa un claim')
  })

  it('la respuesta NO trae ningun veredicto que se pueda usar de gate', () => {
    // Es deliberado: un booleano aqui es una invitacion a montar un bloqueo el
    // dia que alguien tenga prisa. Quien quiera bloquear tiene que escribir la
    // regla, y entonces la discusion ocurre.
    const aviso = crossWithClaims({ predicted, activeClaims: [], holderId: 'u-ana' })
    expect(Object.keys(aviso).sort()).toEqual(['overlaps', 'predicted', 'summary'])
  })

  it('sin saber quien va a trabajar, se lanza', () => {
    expect(() => crossWithClaims({ predicted, activeClaims: [], holderId: '  ' })).toThrow(
      ValidationError,
    )
  })
})

describe('el umbral por defecto es el documentado', () => {
  it('vale 0.2', () => {
    expect(DEFAULT_MIN_CONFIDENCE).toBe(0.2)
  })
})
