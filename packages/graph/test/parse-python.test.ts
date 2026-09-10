import { describe, expect, it } from 'vitest'

import { pythonLanguageParser } from '../src/parse/python.js'
import type { ParsedImport, RepoFileIndex } from '../src/parse/types.js'

/**
 * El parser de Python, MIRANDO EL ARBOL y no la cuenta de nodos que acaba en la
 * base de datos (issue #48).
 *
 * Hasta ahora este fichero se ejercitaba de refilon desde `ingest.test.ts`, que
 * comprueba cuantos nodos y aristas se escriben. Eso deja pasar cualquier
 * cambio que rompa QUE es cada cosa mientras los recuentos cuadren: confundir
 * una clase con una funcion, ligar un alias al nombre equivocado, o resolver un
 * modulo a un fichero que no es. Medido con mutation testing: 49,83 % con 61
 * mutantes que ningun test tocaba.
 *
 * Son tests PUROS —el contrato de `LanguageParser` no toca Postgres— asi que no
 * levantan nada y se pueden correr solos.
 */

const parse = (source: string) => pythonLanguageParser.parse(source, 'pkg/mod.py')

describe('que se declara en el fichero', () => {
  it('funciones y clases de nivel superior, con su clase de simbolo', () => {
    const { symbols } = parse(`
def suma(a, b):
    return a + b

class Cliente:
    pass
`)

    expect(symbols).toEqual([
      { name: 'suma', symbolKind: 'function' },
      { name: 'Cliente', symbolKind: 'class' },
    ])
  })

  it('una definicion decorada cuenta, y con su nombre real', () => {
    // Sin desenvolver el decorador, el nodo de nivel superior es
    // `decorated_definition` y la funcion desapareceria del grafo. Media base de
    // codigo Python con decoradores quedaria invisible.
    expect(parse('@app.route("/")\ndef inicio():\n    pass\n').symbols).toEqual([
      { name: 'inicio', symbolKind: 'function' },
    ])
  })

  it('lo anidado NO es simbolo de nivel superior', () => {
    // Una funcion dentro de otra no es parte de la API del fichero. Meterla
    // haria que un `blast_radius` señalara como afectado a quien no puede
    // llamarla.
    expect(parse('def fuera():\n    def dentro():\n        pass\n').symbols).toEqual([
      { name: 'fuera', symbolKind: 'function' },
    ])
  })

  it('un nombre redefinido se cuenta UNA vez', () => {
    // La clave natural del nodo es (fichero, nombre): dos entradas con el mismo
    // nombre serian la misma fila insertada dos veces.
    expect(parse('def f():\n    pass\n\ndef f():\n    pass\n').symbols).toHaveLength(1)
  })
})

describe('la herencia', () => {
  it('sale con la clase que hereda como origen', () => {
    const { inherits } = parse('class Perro(Animal):\n    pass\n')
    expect(inherits).toEqual([{ from: 'Perro', name: 'Animal', namespace: null }])
  })

  it('una base con namespace conserva el namespace', () => {
    // `models.Model` tiene que poder resolverse al simbolo `Model` del modulo
    // ligado a `models`, no a cualquier `Model` del repo.
    expect(parse('class Perro(base.Animal):\n    pass\n').inherits).toEqual([
      { from: 'Perro', name: 'Animal', namespace: 'base' },
    ])
  })

  it('una base de dos niveles NO se inventa', () => {
    // `a.b.C` necesitaria seguir dos saltos de modulo. Emitir algo aqui crearia
    // una arista fantasma, y un grafo con aristas que no existen es peor que
    // uno incompleto: nadie sabe cuales creerse.
    expect(parse('class Perro(a.b.Animal):\n    pass\n').inherits).toEqual([])
  })

  it('herencia multiple sale entera', () => {
    expect(parse('class C(A, B):\n    pass\n').inherits.map((r) => r.name)).toEqual(['A', 'B'])
  })
})

describe('las llamadas y desde donde salen', () => {
  it('una llamada dentro de una funcion se atribuye a esa funcion', () => {
    const { calls } = parse('def principal():\n    ayudar()\n')
    expect(calls).toEqual([{ from: 'principal', name: 'ayudar', namespace: null }])
  })

  it('una llamada a nivel de fichero no se atribuye a nadie', () => {
    // `from: null` es informacion, no un hueco: dice que la dependencia es del
    // modulo entero y no de una funcion concreta.
    expect(parse('arrancar()\n').calls).toEqual([{ from: null, name: 'arrancar', namespace: null }])
  })

  it('una llamada dentro de un metodo se atribuye a la CLASE', () => {
    // El simbolo de nivel superior es la clase; el metodo no es nodo propio.
    const { calls } = parse('class C:\n    def m(self):\n        ayudar()\n')
    expect(calls).toEqual([{ from: 'C', name: 'ayudar', namespace: null }])
  })

  it('`ns.foo()` conserva el namespace', () => {
    expect(parse('def f():\n    util.limpiar()\n').calls).toEqual([
      { from: 'f', name: 'limpiar', namespace: 'util' },
    ])
  })

  it('`a.b.foo()` NO se captura', () => {
    // Dos niveles: no se puede saber a que modulo pertenece sin adivinar.
    expect(parse('def f():\n    os.path.join(x)\n').calls).toEqual([])
  })
})

describe('los imports: quien queda ligado a que', () => {
  const importsDe = (source: string): ParsedImport[] => [...parse(source).imports]

  it('`import a.b` depende del modulo y NO liga nada util', () => {
    // Liga el nombre `a`, no `a.b`. Como `a.b.foo()` tampoco se resuelve (dos
    // niveles), declarar una ligadura aqui solo serviria para resolver mal.
    expect(importsDe('import a.b\n')).toEqual([{ specifier: 'a.b', bindings: [] }])
  })

  it('`import a.b as ab` liga un NAMESPACE, no un simbolo', () => {
    // `ab` es el modulo entero: `ab.foo` se resuelve buscando `foo` dentro de
    // `a.b`. Marcarlo como `named` haria buscar un simbolo llamado `ab`.
    expect(importsDe('import a.b as ab\n')).toEqual([
      { specifier: 'a.b', bindings: [{ local: 'ab', imported: null, kind: 'namespace' }] },
    ])
  })

  it('`from m import a` liga el nombre a si mismo', () => {
    expect(importsDe('from m import a\n')).toEqual([
      { specifier: 'm', bindings: [{ local: 'a', imported: 'a', kind: 'named' }] },
    ])
  })

  it('`from m import a as b` distingue el nombre local del importado', () => {
    // Si se guardara `b` como `imported`, se buscaria un simbolo `b` en `m` y no
    // existe. El alias es local a ESTE fichero.
    expect(importsDe('from m import a as b\n')).toEqual([
      { specifier: 'm', bindings: [{ local: 'b', imported: 'a', kind: 'named' }] },
    ])
  })

  it('`from paquete import modulo` apunta al MODULO, no al paquete', () => {
    // `from . import x` no importa un simbolo `x` del paquete: importa el modulo
    // `x` que hay dentro. El especificador tiene que apuntar ahi, o la arista
    // saldria contra el `__init__.py`.
    expect(importsDe('from . import x\n')).toEqual([
      { specifier: '.x', bindings: [{ local: 'x', imported: null, kind: 'namespace' }] },
    ])
  })

  it('y con dos puntos sube un nivel mas', () => {
    expect(importsDe('from .. import x\n')[0]?.specifier).toBe('..x')
  })

  it('`from . import a, b` emite un import POR MODULO', () => {
    expect(importsDe('from . import a, b\n').map((i) => i.specifier)).toEqual(['.a', '.b'])
  })

  it('`from .mod import a` si liga un simbolo', () => {
    expect(importsDe('from .mod import a\n')).toEqual([
      { specifier: '.mod', bindings: [{ local: 'a', imported: 'a', kind: 'named' }] },
    ])
  })

  it('un `import *` deja el modulo como dependencia y sin ligaduras', () => {
    // La dependencia es real y tiene que salir en el grafo; que nombres entran
    // no se puede saber sin resolver el otro fichero, y no se adivina.
    expect(importsDe('from m import *\n')).toEqual([{ specifier: 'm', bindings: [] }])
  })

  it('los imports dentro de una funcion tambien cuentan', () => {
    // Un import diferido es una dependencia igual. Mirar solo el nivel superior
    // perderia las dependencias de los ficheros que evitan ciclos asi.
    expect(importsDe('def f():\n    import json\n')).toEqual([{ specifier: 'json', bindings: [] }])
  })
})

describe('a que fichero apunta un modulo', () => {
  const resolver = (specifier: string, fromPath: string, files: RepoFileIndex) =>
    pythonLanguageParser.resolveSpecifier(specifier, fromPath, files)

  it('un relativo de un punto busca al lado', () => {
    expect(resolver('.util', 'pkg/mod.py', new Set(['pkg/util.py']))).toEqual({
      kind: 'file',
      path: 'pkg/util.py',
    })
  })

  it('un modulo puede ser un paquete con `__init__.py`', () => {
    expect(resolver('.sub', 'pkg/mod.py', new Set(['pkg/sub/__init__.py']))).toEqual({
      kind: 'file',
      path: 'pkg/sub/__init__.py',
    })
  })

  it('tambien vale un `.pyi`', () => {
    expect(resolver('.util', 'pkg/mod.py', new Set(['pkg/util.pyi']))).toEqual({
      kind: 'file',
      path: 'pkg/util.pyi',
    })
  })

  it('el fichero gana al paquete cuando existen los dos', () => {
    // El orden de `moduleCandidates` no es decorativo: es el orden en el que
    // Python resuelve. Invertirlo daria la arista al fichero equivocado.
    expect(
      resolver('.util', 'pkg/mod.py', new Set(['pkg/util.py', 'pkg/util/__init__.py'])),
    ).toEqual({ kind: 'file', path: 'pkg/util.py' })
  })

  it('cada punto de mas sube un nivel', () => {
    expect(resolver('..otro', 'a/b/mod.py', new Set(['a/otro.py']))).toEqual({
      kind: 'file',
      path: 'a/otro.py',
    })
  })

  it('subir mas alla de la raiz NO resuelve', () => {
    // Inventarse un fichero fuera del repo seria una arista a la nada.
    expect(resolver('....x', 'a/mod.py', new Set(['x.py']))).toEqual({ kind: 'unresolved' })
  })

  it('un punto solo apunta al paquete que contiene el fichero', () => {
    expect(resolver('.', 'pkg/mod.py', new Set(['pkg/__init__.py']))).toEqual({
      kind: 'file',
      path: 'pkg/__init__.py',
    })
  })

  it('un absoluto que existe en el repo es un fichero', () => {
    expect(resolver('pkg.util', 'otro/mod.py', new Set(['pkg/util.py']))).toEqual({
      kind: 'file',
      path: 'pkg/util.py',
    })
  })

  it('un absoluto que no existe es un PAQUETE, con su primer segmento', () => {
    // `os.path` es el paquete distribuible `os`. Guardar `os.path` crearia un
    // nodo de paquete por cada submodulo, y contar dependencias externas daria
    // numeros inflados.
    expect(resolver('os.path', 'pkg/mod.py', new Set())).toEqual({ kind: 'package', name: 'os' })
  })

  it('un especificador con un hueco no resuelve', () => {
    // `a..b` no es un modulo; tratarlo como tal produciria la ruta `a//b.py`.
    expect(resolver('a..b', 'pkg/mod.py', new Set(['a/b.py']))).toEqual({ kind: 'unresolved' })
  })

  it('un especificador vacio no resuelve', () => {
    expect(resolver('', 'pkg/mod.py', new Set())).toEqual({ kind: 'unresolved' })
  })

  it('un relativo que no existe NO se degrada a paquete externo', () => {
    // Un import relativo roto es un fallo del repo, no una dependencia de PyPI.
    // Devolver `package` lo escondería detrás de un nodo externo plausible.
    expect(resolver('.noexiste', 'pkg/mod.py', new Set(['pkg/otro.py']))).toEqual({
      kind: 'unresolved',
    })
  })
})

describe('el parser se declara', () => {
  it('atiende .py y .pyi', () => {
    expect(pythonLanguageParser.language).toBe('python')
    expect(pythonLanguageParser.extensions).toEqual(['.py', '.pyi'])
  })

  it('un fichero vacio no revienta y no inventa nada', () => {
    expect(parse('')).toEqual({ symbols: [], imports: [], calls: [], inherits: [] })
  })

  it('un fichero con sintaxis rota devuelve lo que se pueda leer', () => {
    // tree-sitter es tolerante a errores a proposito: media rama en mitad de un
    // refactor sigue dando grafo. Abortar aqui dejaria el indice congelado.
    expect(parse('def f(:\n    pass\n\ndef g():\n    pass\n').symbols.length).toBeGreaterThan(0)
  })
})
