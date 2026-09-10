import { describe, expect, it } from 'vitest'

import { ValidationError } from './errors.js'
import {
  MIN_SAMPLE_FOR_ALERT,
  summarizeRoutingAccuracy,
  type RoutingOutcomeRecord,
} from './routing-accuracy.js'

/**
 * La regla de conteo de T04 (epic 03), sin base de datos.
 *
 * Es la metrica que decide si el epic 03 valia la pena, asi que lo que se fija
 * aqui es COMO se cuenta — que es donde se cuela el autoengano en cualquier
 * metrica de acierto.
 */

/** `n` sugerencias aceptadas y `m` anuladas, ya resueltas. */
function registros(aceptadas: number, anuladas: number): RoutingOutcomeRecord[] {
  return [
    ...Array.from({ length: aceptadas }, (_v, i) => ({
      taskRef: `issue-a${String(i)}`,
      suggestedFirst: 'ana',
      assignedTo: 'ana',
    })),
    ...Array.from({ length: anuladas }, (_v, i) => ({
      taskRef: `issue-b${String(i)}`,
      suggestedFirst: 'ana',
      assignedTo: 'bruno',
    })),
  ]
}

describe('lo que entra en el denominador', () => {
  it('una sugerencia sin asignar todavia NO cuenta como anulacion', () => {
    // Si contara, la tasa empeoraria sola los viernes por la tarde, cuando
    // nadie asigna nada. Estaria midiendo el calendario, no el router.
    const resumen = summarizeRoutingAccuracy([
      { taskRef: 'issue-1', suggestedFirst: 'ana', assignedTo: 'ana' },
      { taskRef: 'issue-2', suggestedFirst: 'ana' },
      { taskRef: 'issue-3', suggestedFirst: 'bruno' },
    ])

    expect(resumen.decided).toBe(1)
    expect(resumen.pending).toBe(2)
    expect(resumen.acceptanceRate).toBe(1)
  })

  it('un `no_match` NO es un fallo del router', () => {
    // Decir "sin match claro" es una respuesta legitima y esperada (T02).
    // Contarla como anulacion castigaria la honestidad y empujaria hacia un
    // router que siempre suelta un nombre.
    const resumen = summarizeRoutingAccuracy([
      { taskRef: 'issue-1', suggestedFirst: 'ana', assignedTo: 'ana' },
      { taskRef: 'issue-2', assignedTo: 'bruno' },
      { taskRef: 'issue-3' },
    ])

    expect(resumen.noMatch).toBe(2)
    expect(resumen.decided).toBe(1)
    expect(resumen.acceptanceRate).toBe(1)
  })

  it('acertar es que se asigne a QUIEN IBA PRIMERO, no a cualquiera de la lista', () => {
    // "Estaba entre los tres primeros" es otra metrica y va aparte. Mezclarlas
    // seria ablandar esta hasta que siempre saliera bien.
    const resumen = summarizeRoutingAccuracy([
      { taskRef: 'issue-1', suggestedFirst: 'ana', assignedTo: 'bruno' },
    ])

    expect(resumen.acceptedFirst).toBe(0)
    expect(resumen.acceptanceRate).toBe(0)
  })
})

describe('sin datos no se inventa una tasa', () => {
  it('con todo pendiente, la tasa es undefined y no cero', () => {
    // "0% de aciertos" y "todavia no hay nada medido" son cosas distintas.
    const resumen = summarizeRoutingAccuracy([
      { taskRef: 'issue-1', suggestedFirst: 'ana' },
      { taskRef: 'issue-2', suggestedFirst: 'bruno' },
    ])

    expect(resumen.acceptanceRate).toBeUndefined()
    expect(resumen.overrideRate).toBeUndefined()
    expect(resumen.alert).toBe(false)
    expect(resumen.summary).toContain('no es lo mismo que una tasa del 0%')
  })

  it('sin ningun registro tampoco', () => {
    expect(summarizeRoutingAccuracy([]).acceptanceRate).toBeUndefined()
  })
})

describe('la alerta: cuando salta y cuando NO', () => {
  it('no salta por debajo de la muestra minima, aunque se anule todo', () => {
    // Tres anulaciones de tres dan un 100% y no significan nada. Sin este
    // piso, la alerta salta la primera semana, nadie la cree, y deja de
    // mirarse — el mismo modo de fallo que un gate siempre rojo.
    const resumen = summarizeRoutingAccuracy(registros(0, 3))

    expect(resumen.overrideRate).toBe(1)
    expect(resumen.alert).toBe(false)
    // Y DICE por que no salta: una alerta silenciosa que no se explica es
    // indistinguible de una alerta rota.
    expect(resumen.summary).toContain('NO se alerta')
    expect(resumen.summary).toContain(String(MIN_SAMPLE_FOR_ALERT))
  })

  it('salta con muestra suficiente y mas de la mitad anuladas', () => {
    const resumen = summarizeRoutingAccuracy(registros(4, 6))

    expect(resumen.decided).toBe(10)
    expect(resumen.overrideRate).toBeCloseTo(0.6)
    expect(resumen.alert).toBe(true)
    expect(resumen.summary).toContain('ALERTA')
    expect(resumen.summary).toContain('revisar')
  })

  it('exactamente la mitad NO dispara: el criterio dice "supere el 50%"', () => {
    // El borde importa. Con `>=` en vez de `>`, un equipo que anula justo la
    // mitad viviria con una alerta encendida sin haber cruzado nada.
    const resumen = summarizeRoutingAccuracy(registros(5, 5))

    expect(resumen.overrideRate).toBe(0.5)
    expect(resumen.alert).toBe(false)
    expect(resumen.summary).toContain('por debajo del umbral')
  })

  it('justo en la muestra minima ya se puede alertar', () => {
    expect(summarizeRoutingAccuracy(registros(4, 6)).alert).toBe(true)
    expect(summarizeRoutingAccuracy(registros(3, 6)).decided).toBe(9)
    expect(summarizeRoutingAccuracy(registros(3, 6)).alert).toBe(false)
  })

  it('el umbral y la muestra se pueden ajustar por llamada', () => {
    // Para que el piloto pueda empezar con un piso mas bajo sin recompilar.
    expect(summarizeRoutingAccuracy(registros(0, 3), { minSample: 3 }).alert).toBe(true)
    expect(summarizeRoutingAccuracy(registros(7, 3), { overrideThreshold: 0.2 }).alert).toBe(true)
  })
})

describe('el resumen se lee sin abrir el codigo', () => {
  it('dice cuantas de cuantas y en que porcentaje', () => {
    const resumen = summarizeRoutingAccuracy(registros(7, 3))
    expect(resumen.summary).toContain('7 de 10')
    expect(resumen.summary).toContain('70.0%')
  })
})

describe('configuracion incoherente: se lanza', () => {
  it.each([0, -1, 2.5])('una muestra minima de %s', (minSample) => {
    expect(() => summarizeRoutingAccuracy([], { minSample })).toThrow(ValidationError)
  })

  it.each([0, -0.1, 1.5])('un umbral de %s', (overrideThreshold) => {
    expect(() => summarizeRoutingAccuracy([], { overrideThreshold })).toThrow(ValidationError)
  })
})

describe('los bordes de la configuracion son validos, no invalidos', () => {
  it('una muestra minima de 1 se acepta: alertar al primer caso es una politica legitima', () => {
    // El limite es `>= 1`, no `> 1`. Un equipo que quiera saltar a la primera
    // anulacion esta eligiendo, no equivocandose.
    const resumen = summarizeRoutingAccuracy(
      [{ taskRef: 'issue-1', suggestedFirst: 'ana', assignedTo: 'bruno' }],
      { minSample: 1 },
    )
    expect(resumen.alert).toBe(true)
  })

  it('un umbral de 1 se acepta: alertar solo si se anula TODO', () => {
    // El limite es `<= 1`, no `< 1`. Exigir el 100% es un umbral muy laxo, pero
    // es un umbral, no una entrada invalida.
    expect(() => summarizeRoutingAccuracy([], { overrideThreshold: 1 })).not.toThrow()
    // Y con el 100% exacto no salta, porque el criterio dice "supere".
    expect(summarizeRoutingAccuracy(registros(0, 12), { overrideThreshold: 1 }).alert).toBe(false)
  })
})
