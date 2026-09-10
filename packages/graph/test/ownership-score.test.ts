import { ValidationError } from '@coord/core'
import { describe, expect, it } from 'vitest'

import { parseNumstatLog, type AuthorshipCommit } from '../src/ownership/git.js'
import { computeOwnership } from '../src/ownership/score.js'

/**
 * La regla de ownership (epic 03 / T01), sin git y sin base de datos.
 *
 * Es lo que hay que discutir cuando alguien diga que el ranking está mal, así
 * que se prueba en milisegundos.
 */

let siguienteSha = 0

function commit(
  email: string,
  files: Record<string, number>,
  opciones: { at?: string; name?: string } = {},
): AuthorshipCommit {
  siguienteSha += 1
  return {
    sha: String(siguienteSha).padStart(40, '0'),
    authorEmail: email,
    authorName: opciones.name ?? email.split('@')[0] ?? email,
    at: new Date(opciones.at ?? '2026-06-01T10:00:00Z'),
    files: Object.entries(files).map(([path, lines]) => ({ path, lines })),
  }
}

/** Un commit mecánico: toca muchísimos ficheros con pocas líneas cada uno. */
function reformateoMasivo(email: string, cuantosFicheros: number): AuthorshipCommit {
  const files: Record<string, number> = { 'src/router.ts': 40 }
  for (let i = 0; i < cuantosFicheros - 1; i += 1) {
    files[`src/otro-${String(i)}.ts`] = 4
  }
  return commit(email, files)
}

describe('el commit de reformateo masivo no distorsiona nada', () => {
  it('se descarta ENTERO, no se diluye', () => {
    // El criterio de aceptación con dientes de T01. La alternativa que se
    // descartó era ponderar por 1/ficheros, que deja señal residual: aquí el
    // reformateo tiene que aportar CERO, no "poco".
    const resultado = computeOwnership(
      [
        reformateoMasivo('formateador@ejemplo.test', 400),
        commit('autora@ejemplo.test', { 'src/router.ts': 12 }),
      ],
      ['src/router.ts'],
    )

    const owners = resultado.files[0]?.owners ?? []
    expect(owners.map((o) => o.authorEmail)).toEqual(['autora@ejemplo.test'])
    expect(owners[0]?.share).toBe(1)
    expect(resultado.discardedByBreadth).toBe(1)
  })

  it('el tope se mide sobre TODOS los ficheros del commit, no solo sobre los que interesan', () => {
    // Un `format all` de 400 ficheros que casualmente toca uno de los nuestros
    // sigue siendo un `format all`. Si el tope se midiera después de filtrar,
    // ese commit parecería un cambio enfocado de un solo fichero.
    const resultado = computeOwnership(
      [reformateoMasivo('formateador@ejemplo.test', 400)],
      ['src/router.ts'],
    )

    expect(resultado.files).toEqual([])
    expect(resultado.discardedByBreadth).toBe(1)
  })

  it('un commit justo en el tope SÍ cuenta', () => {
    // El límite es "más de N", no "N o más". Un commit de exactamente 50
    // ficheros es grande pero puede ser un cambio real.
    const enElTope = reformateoMasivo('autora@ejemplo.test', 50)
    const resultado = computeOwnership([enElTope], ['src/router.ts'], { maxFilesPerCommit: 50 })

    expect(resultado.discardedByBreadth).toBe(0)
    expect(resultado.files[0]?.owners[0]?.authorEmail).toBe('autora@ejemplo.test')
  })

  it('respeta una lista de shas ignorados, que es lo que alimenta .git-blame-ignore-revs', () => {
    // Cuando el repositorio marca a mano sus commits mecánicos, esa señal es
    // mejor que cualquier heurística nuestra: la puso una persona.
    const mecanico = commit('formateador@ejemplo.test', { 'src/router.ts': 900 })
    const real = commit('autora@ejemplo.test', { 'src/router.ts': 10 })

    const resultado = computeOwnership([mecanico, real], ['src/router.ts'], {
      ignoreShas: [mecanico.sha],
    })

    expect(resultado.files[0]?.owners.map((o) => o.authorEmail)).toEqual(['autora@ejemplo.test'])
    expect(resultado.discardedByIgnoreList).toBe(1)
    // No se contó como descartado por amplitud: son dos motivos distintos y
    // quien lea el resultado tiene que poder distinguirlos.
    expect(resultado.discardedByBreadth).toBe(0)
  })
})

describe('ordena por evidencia de autoría, no por número de commits', () => {
  it('quien escribió el fichero gana a quien pasó por encima muchas veces', () => {
    // Es el primer criterio de aceptación, literal. Contar commits pondría
    // primero al de las tres erratas.
    const resultado = computeOwnership(
      [
        commit('autora@ejemplo.test', { 'src/router.ts': 400 }),
        commit('erratas@ejemplo.test', { 'src/router.ts': 1 }),
        commit('erratas@ejemplo.test', { 'src/router.ts': 1 }),
        commit('erratas@ejemplo.test', { 'src/router.ts': 1 }),
      ],
      ['src/router.ts'],
    )

    const owners = resultado.files[0]?.owners ?? []
    expect(owners[0]?.authorEmail).toBe('autora@ejemplo.test')
    expect(owners[0]?.commits).toBe(1)
    expect(owners[1]?.commits).toBe(3)
    // Y la proporción es citable: 400 de 403 líneas.
    expect(owners[0]?.share).toBeCloseTo(400 / 403, 5)
  })

  it('a igualdad de líneas, desempata el número de commits', () => {
    const resultado = computeOwnership(
      [
        commit('constante@ejemplo.test', { 'src/router.ts': 10 }),
        commit('constante@ejemplo.test', { 'src/router.ts': 10 }),
        commit('puntual@ejemplo.test', { 'src/router.ts': 20 }),
      ],
      ['src/router.ts'],
    )

    expect(resultado.files[0]?.owners[0]?.authorEmail).toBe('constante@ejemplo.test')
  })

  it('el orden es determinista aunque todo empate', () => {
    // Sin desempate final, dos ejecuciones sobre los mismos datos pueden dar
    // órdenes distintos según cómo se construyó el Map. Una sugerencia que
    // cambia sin que cambien los datos no se le puede explicar a nadie.
    const mismos = { 'src/router.ts': 10 }
    const primero = computeOwnership(
      [
        commit('zeta@ejemplo.test', mismos, { at: '2026-06-01T10:00:00Z' }),
        commit('alfa@ejemplo.test', mismos, { at: '2026-06-01T10:00:00Z' }),
      ],
      ['src/router.ts'],
    )
    const segundo = computeOwnership(
      [
        commit('alfa@ejemplo.test', mismos, { at: '2026-06-01T10:00:00Z' }),
        commit('zeta@ejemplo.test', mismos, { at: '2026-06-01T10:00:00Z' }),
      ],
      ['src/router.ts'],
    )

    expect(primero.files[0]?.owners.map((o) => o.authorEmail)).toEqual([
      'alfa@ejemplo.test',
      'zeta@ejemplo.test',
    ])
    expect(segundo.files[0]?.owners.map((o) => o.authorEmail)).toEqual(
      primero.files[0]?.owners.map((o) => o.authorEmail),
    )
  })
})

describe('la identidad de una persona', () => {
  it('agrupa por email, no por nombre', () => {
    // El nombre cambia ("Javier", "javier viseras", "JVISERASS") y agruparía a
    // la misma persona en tres.
    const resultado = computeOwnership(
      [
        commit('javier@ejemplo.test', { 'src/router.ts': 10 }, { name: 'Javier' }),
        commit('javier@ejemplo.test', { 'src/router.ts': 10 }, { name: 'JVISERASS' }),
      ],
      ['src/router.ts'],
    )

    expect(resultado.files[0]?.owners).toHaveLength(1)
    expect(resultado.files[0]?.owners[0]?.lines).toBe(20)
  })

  it('enseña el nombre del commit más reciente', () => {
    // Si alguien cambió cómo se firma, lo útil es cómo se firma ahora.
    const resultado = computeOwnership(
      [
        commit(
          'javier@ejemplo.test',
          { 'src/router.ts': 10 },
          { name: 'Nombre viejo', at: '2026-01-01T10:00:00Z' },
        ),
        commit(
          'javier@ejemplo.test',
          { 'src/router.ts': 10 },
          { name: 'Nombre nuevo', at: '2026-06-01T10:00:00Z' },
        ),
      ],
      ['src/router.ts'],
    )

    expect(resultado.files[0]?.owners[0]?.authorName).toBe('Nombre nuevo')
  })
})

describe('casos borde que no se inventan una respuesta', () => {
  it('un fichero que nadie tocó dentro de la ventana no aparece', () => {
    const resultado = computeOwnership(
      [commit('a@ejemplo.test', { 'src/otro.ts': 5 })],
      ['src/router.ts'],
    )
    expect(resultado.files).toEqual([])
  })

  it('un fichero solo con cambios binarios reparte cero, no divide entre cero', () => {
    const resultado = computeOwnership(
      [commit('a@ejemplo.test', { 'assets/logo.png': 0 })],
      ['assets/logo.png'],
    )

    const owner = resultado.files[0]?.owners[0]
    expect(owner?.lines).toBe(0)
    expect(owner?.commits).toBe(1)
    // Cero y no NaN: repartir por commits aquí sería inventarse otra escala a
    // mitad de la lista.
    expect(owner?.share).toBe(0)
  })

  it('un tope de cero ficheros se rechaza', () => {
    expect(() => computeOwnership([], undefined, { maxFilesPerCommit: 0 })).toThrow(ValidationError)
  })
})

describe('el parseo de git, sin ejecutar git', () => {
  it('lee sha, autor, fecha y líneas por fichero', () => {
    const stdout =
      '\x01abc123\x02Javier@Ejemplo.TEST\x02Javier\x022026-06-01T10:00:00+02:00\x02\n' +
      '10\t2\tsrc/router.ts\n' +
      '0\t5\tsrc/viejo.ts\n'

    const [commitLeido] = parseNumstatLog(stdout)

    expect(commitLeido?.sha).toBe('abc123')
    // El email se normaliza a minúsculas: es la clave de agrupación.
    expect(commitLeido?.authorEmail).toBe('javier@ejemplo.test')
    expect(commitLeido?.authorName).toBe('Javier')
    expect(commitLeido?.files).toEqual([
      { path: 'src/router.ts', lines: 12 },
      { path: 'src/viejo.ts', lines: 5 },
    ])
  })

  it('un binario cuenta como fichero tocado con cero líneas', () => {
    // git escribe `-\t-\t<ruta>`. Descartarlo perdería el hecho de que alguien
    // lo tocó; contarlo como líneas sería inventarse un número.
    const stdout =
      '\x01abc\x02a@ejemplo.test\x02A\x022026-06-01T10:00:00Z\x02\n-\t-\tassets/logo.png\n'

    expect(parseNumstatLog(stdout)[0]?.files).toEqual([{ path: 'assets/logo.png', lines: 0 }])
  })

  it('una ruta con espacios o acentos llega entera', () => {
    const stdout =
      '\x01abc\x02a@ejemplo.test\x02A\x022026-06-01T10:00:00Z\x02\n3\t1\tsrc/año de gracia.ts\n'

    expect(parseNumstatLog(stdout)[0]?.files[0]?.path).toBe('src/año de gracia.ts')
  })

  it('un historial vacío devuelve una lista vacía, no revienta', () => {
    expect(parseNumstatLog('')).toEqual([])
  })
})
