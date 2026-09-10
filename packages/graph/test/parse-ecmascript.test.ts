import { describe, expect, it } from 'vitest'

import { javascriptLanguageParser } from '../src/parse/javascript.js'
import { typescriptLanguageParser } from '../src/parse/typescript.js'
import type { ParsedFile, RepoFileIndex } from '../src/parse/types.js'

/**
 * El parser de la familia ECMAScript (`ecmascript.ts`), que es el que de verdad
 * usan TypeScript y JavaScript: los dos modulos de lenguaje solo eligen
 * gramatica y extensiones.
 *
 * Se prueba MIRANDO EL ARBOL, no la cuenta de nodos que acaba en la base de
 * datos (issue #48). Un cambio que confunda una clase con una funcion, o que
 * ligue un alias al nombre equivocado, no mueve ningun recuento — y sin embargo
 * rompe la resolucion de simbolos entre ficheros, que es para lo que existe
 * este grafo.
 *
 * Son tests PUROS: el contrato de `LanguageParser` no toca Postgres.
 */

const ts = (source: string, path = 'src/mod.ts'): ParsedFile =>
  typescriptLanguageParser.parse(source, path)

const nombres = (file: ParsedFile) => file.symbols.map((s) => `${s.symbolKind}:${s.name}`)

describe('que se declara en el fichero', () => {
  it('las cinco clases de declaracion, exportadas o no', () => {
    expect(
      nombres(
        ts(`
export function f() {}
class C {}
export interface I {}
type T = string
enum E { A }
`),
      ),
    ).toEqual(['function:f', 'class:C', 'interface:I', 'type:T', 'enum:E'])
  })

  it('una `const` con una funcion flecha ES una funcion', () => {
    // Es la forma mas comun de declarar en este repo. Tratarla como "no es una
    // declaracion" dejaria fuera del grafo la mitad de los simbolos.
    expect(nombres(ts('export const f = () => {}\n'))).toEqual(['function:f'])
  })

  it('una `const` con una expresion de clase ES una clase', () => {
    expect(nombres(ts('const C = class {}\n'))).toEqual(['class:C'])
  })

  it('una `const` con cualquier otro valor NO es un simbolo', () => {
    // Un grafo de dependencias entre constantes de configuracion no dice nada
    // util y multiplica los nodos.
    expect(nombres(ts('export const LIMITE = 10\nconst nombres = ["a"]\n'))).toEqual([])
  })

  it('`export default class {}` se salta: no tiene clave natural', () => {
    // La clave del nodo es (fichero, nombre). Sin nombre no hay fila posible, y
    // inventarse "default" haria colisionar dos ficheros distintos.
    expect(nombres(ts('export default class {}\n'))).toEqual([])
  })

  it('un nombre repetido se cuenta una vez', () => {
    expect(ts('function f() {}\nfunction f() {}\n').symbols).toHaveLength(1)
  })

  it('lo anidado no es simbolo de nivel superior', () => {
    expect(nombres(ts('function fuera() {\n  function dentro() {}\n}\n'))).toEqual([
      'function:fuera',
    ])
  })
})

describe('la herencia', () => {
  it('`extends` sale con la clase que hereda como origen', () => {
    expect(ts('class Perro extends Animal {}\n').inherits).toEqual([
      { from: 'Perro', name: 'Animal', namespace: null },
    ])
  })

  it('`implements` cuenta igual que `extends`', () => {
    // Para el radio de impacto, implementar una interfaz es depender de ella:
    // si cambia, este fichero deja de compilar.
    expect(ts('class C extends B implements I {}\n').inherits.map((r) => r.name)).toEqual([
      'B',
      'I',
    ])
  })

  it('una interfaz que extiende otra tambien', () => {
    expect(ts('interface A extends B {}\n').inherits).toEqual([
      { from: 'A', name: 'B', namespace: null },
    ])
  })

  it('una clase asignada a una `const` conserva el nombre de la const', () => {
    // El simbolo del grafo se llama `C`, no "la clase anonima": la herencia
    // tiene que colgar del mismo nombre o queda huerfana.
    expect(ts('const C = class extends B {}\n').inherits).toEqual([
      { from: 'C', name: 'B', namespace: null },
    ])
  })

  it('`extends ns.Base` conserva el namespace', () => {
    expect(ts('class C extends base.Animal {}\n').inherits).toEqual([
      { from: 'C', name: 'Animal', namespace: 'base' },
    ])
  })
})

describe('las llamadas y desde donde salen', () => {
  it('dentro de una funcion se atribuyen a esa funcion', () => {
    expect(ts('function principal() {\n  ayudar()\n}\n').calls).toEqual([
      { from: 'principal', name: 'ayudar', namespace: null },
    ])
  })

  it('a nivel de fichero no se atribuyen a nadie', () => {
    expect(ts('arrancar()\n').calls).toEqual([{ from: null, name: 'arrancar', namespace: null }])
  })

  it('`obj.metodo()` conserva el namespace', () => {
    expect(ts('function f() {\n  util.limpiar()\n}\n').calls).toEqual([
      { from: 'f', name: 'limpiar', namespace: 'util' },
    ])
  })

  it('`a.b.c()` NO se captura', () => {
    // Dos niveles: no se sabe a que modulo pertenece sin adivinar, y una arista
    // fantasma es peor que una ausente.
    expect(ts('function f() {\n  a.b.c()\n}\n').calls).toEqual([])
  })

  it('un `new` cuenta como llamada', () => {
    // Construir es depender igual que llamar. Sin esto, un fichero que solo
    // instancia una clase de otro no tendria arista.
    expect(ts('function f() {\n  new Cliente()\n}\n').calls).toEqual([
      { from: 'f', name: 'Cliente', namespace: null },
    ])
  })

  it('un `new ns.Cosa()` conserva el namespace', () => {
    expect(ts('function f() {\n  new api.Cliente()\n}\n').calls).toEqual([
      { from: 'f', name: 'Cliente', namespace: 'api' },
    ])
  })

  it('una llamada dentro de un metodo se atribuye a la CLASE', () => {
    expect(ts('class C {\n  m() {\n    ayudar()\n  }\n}\n').calls).toEqual([
      { from: 'C', name: 'ayudar', namespace: null },
    ])
  })
})

describe('los imports: quien queda ligado a que', () => {
  it('`import x from` es un `default` y no se puede resolver a un simbolo', () => {
    // No sabemos con que nombre esta declarado en el modulo de origen, asi que
    // `imported` es null a proposito.
    expect(ts("import x from 'm'\n").imports).toEqual([
      { specifier: 'm', bindings: [{ local: 'x', imported: null, kind: 'default' }] },
    ])
  })

  it('`import * as ns` es un namespace', () => {
    expect(ts("import * as ns from 'm'\n").imports).toEqual([
      { specifier: 'm', bindings: [{ local: 'ns', imported: null, kind: 'namespace' }] },
    ])
  })

  it('`import { a }` liga el nombre a si mismo', () => {
    expect(ts("import { a } from 'm'\n").imports[0]?.bindings).toEqual([
      { local: 'a', imported: 'a', kind: 'named' },
    ])
  })

  it('`import { a as b }` distingue local de importado', () => {
    // Guardar `b` como `imported` haria buscar un simbolo `b` en `m`, que no
    // existe: el alias es local a ESTE fichero.
    expect(ts("import { a as b } from 'm'\n").imports[0]?.bindings).toEqual([
      { local: 'b', imported: 'a', kind: 'named' },
    ])
  })

  it('varias formas en la misma linea salen todas', () => {
    expect(ts("import def, { a as b } from 'm'\n").imports[0]?.bindings).toEqual([
      { local: 'def', imported: null, kind: 'default' },
      { local: 'b', imported: 'a', kind: 'named' },
    ])
  })

  it('un import de solo efecto es dependencia igual, sin ligaduras', () => {
    expect(ts("import './efectos.js'\n").imports).toEqual([
      { specifier: './efectos.js', bindings: [] },
    ])
  })

  it('un especificador vacio no es dependencia de nada', () => {
    expect(ts("import ''\n").imports).toEqual([])
  })

  it('`export ... from` es un import a efectos del grafo', () => {
    // Un fichero barril depende de lo que reexporta, aunque no lo use.
    expect(ts("export { x } from './m.js'\n").imports).toEqual([
      { specifier: './m.js', bindings: [] },
    ])
  })

  it('`export * from` tambien', () => {
    expect(ts("export * from './m.js'\n").imports).toEqual([{ specifier: './m.js', bindings: [] }])
  })

  it('un `import()` dinamico con literal cuenta', () => {
    expect(ts("async function f() {\n  await import('./tarde.js')\n}\n").imports).toEqual([
      { specifier: './tarde.js', bindings: [] },
    ])
  })

  it('un `import()` con expresion NO se inventa', () => {
    // `import(ruta)` no se puede resolver estaticamente. Emitir algo aqui seria
    // adivinar.
    expect(ts('async function f(ruta) {\n  await import(ruta)\n}\n').imports).toEqual([])
  })

  it('un `require()` con literal cuenta', () => {
    expect(ts("const m = require('pg')\n").imports).toEqual([{ specifier: 'pg', bindings: [] }])
  })

  it('un `require()` con expresion no', () => {
    expect(ts('function f(n) {\n  return require(n)\n}\n').imports).toEqual([])
  })

  it('una llamada a otra cosa que se llame parecido sigue siendo una llamada', () => {
    // `requireAuth()` no es un `require`. Confundirlos meteria un import
    // inventado y perderia la llamada real.
    const { imports, calls } = ts("function f() {\n  requireAuth('admin')\n}\n")
    expect(imports).toEqual([])
    expect(calls).toEqual([{ from: 'f', name: 'requireAuth', namespace: null }])
  })
})

describe('a que fichero apunta un especificador', () => {
  const resolver = (specifier: string, files: RepoFileIndex, fromPath = 'src/mod.ts') =>
    typescriptLanguageParser.resolveSpecifier(specifier, fromPath, files)

  it('`./x.js` encuentra `x.ts`: es el ESM de TypeScript', () => {
    // Sin esta reescritura, TODO repo de TypeScript en ESM —este incluido—
    // quedaria con cero aristas de import resueltas.
    expect(resolver('./x.js', new Set(['src/x.ts']))).toEqual({ kind: 'file', path: 'src/x.ts' })
  })

  it('y si de verdad hay un `.js`, tambien vale', () => {
    expect(resolver('./x.js', new Set(['src/x.js']))).toEqual({ kind: 'file', path: 'src/x.js' })
  })

  it('el `.ts` gana al `.js` cuando existen los dos', () => {
    // El orden de la reescritura no es decorativo: el fuente es el `.ts`, y el
    // `.js` de al lado suele ser el compilado.
    expect(resolver('./x.js', new Set(['src/x.ts', 'src/x.js']))).toEqual({
      kind: 'file',
      path: 'src/x.ts',
    })
  })

  it('sin extension se prueban las conocidas', () => {
    expect(resolver('./x', new Set(['src/x.tsx']))).toEqual({ kind: 'file', path: 'src/x.tsx' })
  })

  it('un directorio resuelve a su `index`', () => {
    expect(resolver('./cosas', new Set(['src/cosas/index.ts']))).toEqual({
      kind: 'file',
      path: 'src/cosas/index.ts',
    })
  })

  it('subir por encima de la raiz NO resuelve', () => {
    expect(resolver('../../fuera.js', new Set(['fuera.ts']), 'src/mod.ts')).toEqual({
      kind: 'unresolved',
    })
  })

  it('un relativo que no existe NO se degrada a paquete', () => {
    // Un import roto es un fallo del repo, no una dependencia de npm.
    // Devolver `package` lo escondería detrás de un nodo externo plausible.
    expect(resolver('./noexiste.js', new Set(['src/otro.ts']))).toEqual({ kind: 'unresolved' })
  })

  it('un nudo es un paquete', () => {
    expect(resolver('pg', new Set())).toEqual({ kind: 'package', name: 'pg' })
  })

  it('un subcamino de paquete se queda con el paquete', () => {
    // `lodash/merge` no es un paquete distinto de `lodash`: contar nodos por
    // subcamino inflaria las dependencias externas.
    expect(resolver('lodash/merge', new Set())).toEqual({ kind: 'package', name: 'lodash' })
  })

  it('un paquete con scope conserva el scope', () => {
    expect(resolver('@coord/db', new Set())).toEqual({ kind: 'package', name: '@coord/db' })
  })

  it('y su subcamino tambien', () => {
    expect(resolver('@coord/db/migrate', new Set())).toEqual({
      kind: 'package',
      name: '@coord/db',
    })
  })

  it('un builtin conserva el prefijo `node:`', () => {
    // `node:fs` y `fs` son el mismo modulo pero distinto nombre; partirlo por
    // `/` daria `node:fs` igual, pero quedarse con `node` seria un paquete que
    // no existe.
    expect(resolver('node:fs/promises', new Set())).toEqual({
      kind: 'package',
      name: 'node:fs/promises',
    })
  })

  it('un import interno de `package.json` no se resuelve', () => {
    // Resolverlo exigiria leer e interpretar el package.json de cada paquete.
    expect(resolver('#interno', new Set(['src/interno.ts']))).toEqual({ kind: 'unresolved' })
  })

  it('un especificador vacio no resuelve', () => {
    expect(resolver('', new Set())).toEqual({ kind: 'unresolved' })
  })
})

describe('las dos gramaticas de TypeScript no son intercambiables', () => {
  it('un `.tsx` con JSX conserva sus imports', () => {
    // Es la razon de que haya dos parsers: parseando `.tsx` con la gramatica de
    // TypeScript, el `<` del elemento choca con las aserciones de tipo y el
    // arbol se llena de nodos ERROR. Los imports se perderian en silencio.
    const file = ts("import React from 'react'\nexport const V = () => <div />\n", 'src/v.tsx')
    expect(file.imports).toEqual([
      { specifier: 'react', bindings: [{ local: 'React', imported: null, kind: 'default' }] },
    ])
    expect(nombres(file)).toEqual(['function:V'])
  })

  it('un `.ts` con una asercion de tipo se sigue leyendo bien', () => {
    expect(nombres(ts('const f = <T,>(x: T) => x\n'))).toEqual(['function:f'])
  })
})

describe('JavaScript usa la misma maquinaria', () => {
  it('extrae lo mismo, con su propia gramatica', () => {
    const file = javascriptLanguageParser.parse(
      "import { a } from './m.js'\nexport class C extends B {}\n",
      'src/m.js',
    )
    expect(file.imports[0]?.bindings).toEqual([{ local: 'a', imported: 'a', kind: 'named' }])
    expect(file.inherits).toEqual([{ from: 'C', name: 'B', namespace: null }])
  })

  it('y cubre JSX sin gramatica aparte', () => {
    const file = javascriptLanguageParser.parse('export const V = () => <div />\n', 'src/v.jsx')
    expect(nombres(file)).toEqual(['function:V'])
  })

  it('se declara con sus extensiones', () => {
    expect(javascriptLanguageParser.language).toBe('javascript')
    expect(javascriptLanguageParser.extensions).toEqual(['.js', '.jsx', '.mjs', '.cjs'])
    expect(typescriptLanguageParser.extensions).toEqual(['.ts', '.tsx', '.mts', '.cts'])
  })
})

describe('los bordes', () => {
  it('un fichero vacio no inventa nada', () => {
    expect(ts('')).toEqual({ symbols: [], imports: [], calls: [], inherits: [] })
  })

  it('sintaxis rota devuelve lo que se pueda leer', () => {
    // tree-sitter es tolerante a errores a proposito: media rama en mitad de un
    // refactor sigue dando grafo en vez de congelar el indice.
    expect(nombres(ts('const x = ;\nexport class C {}\n'))).toContain('class:C')
  })
})
