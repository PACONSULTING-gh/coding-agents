import posix from 'node:path/posix'

import type Parser from 'tree-sitter'

import type {
  ImportBinding,
  ParsedFile,
  ParsedImport,
  ParsedReference,
  ParsedSymbol,
  RepoFileIndex,
  ResolvedSpecifier,
  SymbolKind,
} from './types.js'
import { parseSource } from './tree-sitter-buffer.js'
import { UNRESOLVED } from './types.js'

/**
 * Extraccion compartida por TypeScript y JavaScript.
 *
 * Las dos gramaticas son la misma familia (tree-sitter-typescript es un
 * superconjunto de tree-sitter-javascript), asi que el recorrido del arbol es
 * literalmente el mismo codigo. Lo que cambia —que gramatica se carga y que
 * extensiones atiende— vive en `typescript.ts` y `javascript.ts`, que son los
 * modulos por lenguaje que ve el registro.
 *
 * ---------------------------------------------------------------------------
 * QUE SE EXTRAE, Y QUE NO
 * ---------------------------------------------------------------------------
 * Simbolos: SOLO declaraciones de nivel superior con nombre (funciones, clases,
 * interfaces, alias de tipo, enums, y las constantes cuyo valor es una funcion
 * o una clase). No se crean nodos para metodos ni para constantes de datos:
 *
 *   * Un metodo no tiene nombre unico dentro del fichero (dos clases pueden
 *     tener `run()`), y la clave natural del nodo es (ruta, nombre). Nodos
 *     ambiguos producen aristas ambiguas.
 *   * Las llamadas que salen del cuerpo de un metodo se atribuyen al simbolo de
 *     nivel superior que lo contiene, que es la granularidad a la que se
 *     pregunta "si toco esta clase, que se ve afectado".
 *
 * Si algun dia hace falta granularidad de metodo, se cualifica el nombre
 * (`Clase.metodo`) y se cambia la resolucion de referencias a la vez. Hacerlo
 * hoy seria construir sin consumidor (CLAUDE.md 2.4, peldano 1).
 */

type SyntaxNode = Parser.SyntaxNode

/** Declaraciones de nivel superior que producen un nodo `symbol`. */
const DECLARATION_KINDS = new Map<string, SymbolKind>([
  ['function_declaration', 'function'],
  ['generator_function_declaration', 'function'],
  ['function_signature', 'function'],
  ['class_declaration', 'class'],
  ['abstract_class_declaration', 'class'],
  ['interface_declaration', 'interface'],
  ['type_alias_declaration', 'type'],
  ['enum_declaration', 'enum'],
])

/** Valores de una `const`/`let` que cuentan como declaracion de simbolo. */
const FUNCTION_VALUE_TYPES = new Map<string, SymbolKind>([
  ['arrow_function', 'function'],
  ['function', 'function'],
  ['function_expression', 'function'],
  ['generator_function', 'function'],
  ['class', 'class'],
])

/** Extensiones que puede tener un fichero destino, en orden de preferencia. */
const EXTENSION_CANDIDATES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

/**
 * Reescritura de extension del ESM de TypeScript: en ESM el import se escribe
 * con la extension del fichero EMITIDO (`./x.js`) aunque el fichero fuente sea
 * `./x.ts`. Sin esto, todo repo de TypeScript en ESM —incluido este— quedaria
 * con cero aristas de import resueltas.
 */
const EXTENSION_REWRITES = new Map<string, readonly string[]>([
  ['.js', ['.ts', '.tsx', '.js', '.jsx']],
  ['.jsx', ['.tsx', '.jsx']],
  ['.mjs', ['.mts', '.mjs']],
  ['.cjs', ['.cts', '.cjs']],
])

const INDEX_BASENAMES = ['index']

/** Texto de un literal de cadena. `undefined` si no es una cadena simple. */
function stringLiteralValue(node: SyntaxNode | null): string | undefined {
  if (node === null || node.type !== 'string') return undefined
  const fragment = node.namedChildren.find((child) => child.type === 'string_fragment')
  // `import ''` es sintacticamente valido y no apunta a nada: cadena vacia.
  return fragment === undefined ? '' : fragment.text
}

function firstStringArgument(callNode: SyntaxNode): string | undefined {
  const args = callNode.childForFieldName('arguments')
  if (args === null) return undefined
  const first = args.namedChildren[0]
  return first === undefined ? undefined : stringLiteralValue(first)
}

/** Nombre (y namespace) de una referencia a partir del nodo que la expresa. */
function referenceOf(node: SyntaxNode, from: string | null): ParsedReference | undefined {
  switch (node.type) {
    case 'identifier':
    case 'type_identifier':
    case 'shorthand_property_identifier':
      return { from, name: node.text, namespace: null }
    case 'member_expression':
    case 'nested_type_identifier':
    case 'nested_identifier': {
      const object = node.childForFieldName('object') ?? node.childForFieldName('module')
      const property = node.childForFieldName('property') ?? node.childForFieldName('name')
      if (property === null) return undefined
      // Solo un nivel: `a.b.c()` no se resuelve, y no se inventa.
      const namespace = object !== null && object.type === 'identifier' ? object.text : null
      if (namespace === null) return undefined
      return { from, name: property.text, namespace }
    }
    case 'generic_type': {
      const name = node.childForFieldName('name')
      return name === null ? undefined : referenceOf(name, from)
    }
    default:
      return undefined
  }
}

function importBindings(clause: SyntaxNode | null): ImportBinding[] {
  if (clause === null) return []
  const bindings: ImportBinding[] = []
  for (const child of clause.namedChildren) {
    if (child.type === 'identifier') {
      bindings.push({ local: child.text, imported: null, kind: 'default' })
      continue
    }
    if (child.type === 'namespace_import') {
      const name = child.namedChildren.find((node) => node.type === 'identifier')
      if (name !== undefined) {
        bindings.push({ local: name.text, imported: null, kind: 'namespace' })
      }
      continue
    }
    if (child.type === 'named_imports') {
      for (const specifier of child.namedChildren) {
        if (specifier.type !== 'import_specifier') continue
        const name = specifier.childForFieldName('name')
        if (name === null) continue
        const alias = specifier.childForFieldName('alias')
        bindings.push({
          local: alias === null ? name.text : alias.text,
          imported: name.text,
          kind: 'named',
        })
      }
    }
  }
  return bindings
}

interface Collected {
  readonly imports: ParsedImport[]
  readonly calls: ParsedReference[]
  readonly inherits: ParsedReference[]
}

/**
 * Clases base e interfaces implementadas de una declaracion de nivel superior.
 * Cubre `class A extends B implements C` y `interface A extends B`.
 */
function heritageReferences(declaration: SyntaxNode, owner: string): ParsedReference[] {
  const references: ParsedReference[] = []
  for (const child of declaration.namedChildren) {
    if (child.type === 'class_heritage') {
      for (const clause of child.namedChildren) {
        // La gramatica de JavaScript cuelga el identificador DIRECTAMENTE de
        // `class_heritage`; la de TypeScript lo envuelve en `extends_clause`.
        // Sin este caso, NINGUNA herencia de un fichero .js/.jsx llegaba al
        // grafo: `class A extends B` no producia arista. Se descubrio
        // escribiendo los tests de parse (issue #48), no en uso, porque los
        // tests de ingesta solo cuentan nodos y el recuento cuadraba igual.
        const direct = referenceOf(clause, owner)
        if (direct !== undefined) {
          references.push(direct)
          continue
        }
        const value = clause.childForFieldName('value')
        const candidates = value === null ? clause.namedChildren : [value]
        for (const candidate of candidates) {
          const reference = referenceOf(candidate, owner)
          if (reference !== undefined) references.push(reference)
        }
      }
      continue
    }
    if (child.type === 'extends_type_clause' || child.type === 'extends_clause') {
      for (const candidate of child.namedChildren) {
        const reference = referenceOf(candidate, owner)
        if (reference !== undefined) references.push(reference)
      }
    }
  }
  return references
}

/**
 * Declaraciones de nivel superior. Devuelve los simbolos y, por cada nodo del
 * arbol que "pertenece" a un simbolo, su nombre: eso es lo que permite atribuir
 * una llamada al simbolo que la contiene durante el recorrido.
 */
function collectTopLevel(program: SyntaxNode): {
  symbols: ParsedSymbol[]
  owners: Map<number, string>
  inherits: ParsedReference[]
} {
  const symbols: ParsedSymbol[] = []
  const seen = new Set<string>()
  const owners = new Map<number, string>()
  const inherits: ParsedReference[] = []

  const add = (name: string, symbolKind: SymbolKind, ownerNode: SyntaxNode): void => {
    if (name === '' || seen.has(name)) return
    seen.add(name)
    symbols.push({ name, symbolKind })
    owners.set(ownerNode.id, name)
  }

  for (const statement of program.namedChildren) {
    const declaration =
      statement.type === 'export_statement' ? statement.childForFieldName('declaration') : statement
    if (declaration === null) continue

    const declarationKind = DECLARATION_KINDS.get(declaration.type)
    if (declarationKind !== undefined) {
      const name = declaration.childForFieldName('name')
      // `export default class {}` no tiene nombre: no hay clave natural posible.
      if (name === null) continue
      add(name.text, declarationKind, declaration)
      inherits.push(...heritageReferences(declaration, name.text))
      continue
    }

    if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
      for (const declarator of declaration.namedChildren) {
        if (declarator.type !== 'variable_declarator') continue
        const name = declarator.childForFieldName('name')
        const value = declarator.childForFieldName('value')
        if (name === null || value === null || name.type !== 'identifier') continue
        const valueKind = FUNCTION_VALUE_TYPES.get(value.type)
        if (valueKind === undefined) continue
        add(name.text, valueKind, value)
        if (valueKind === 'class') {
          inherits.push(...heritageReferences(value, name.text))
        }
      }
    }
  }

  return { symbols, owners, inherits }
}

function walk(
  node: SyntaxNode,
  owner: string | null,
  owners: ReadonlyMap<number, string>,
  out: Collected,
): void {
  const current = owners.get(node.id) ?? owner

  switch (node.type) {
    case 'import_statement': {
      const specifier = stringLiteralValue(node.childForFieldName('source'))
      if (specifier !== undefined && specifier !== '') {
        const clause = node.namedChildren.find((child) => child.type === 'import_clause') ?? null
        out.imports.push({ specifier, bindings: importBindings(clause) })
      }
      // Nada dentro de un import puede contener llamadas.
      return
    }
    case 'export_statement': {
      // `export { x } from './m.js'` y `export * from './m.js'` son imports a
      // todos los efectos del grafo: este fichero depende de aquel.
      const specifier = stringLiteralValue(node.childForFieldName('source'))
      if (specifier !== undefined && specifier !== '') {
        out.imports.push({ specifier, bindings: [] })
      }
      break
    }
    case 'call_expression': {
      const callee = node.childForFieldName('function')
      if (callee !== null) {
        if (callee.type === 'import') {
          // `import('./m.js')` dinamico con literal. Con expresion, se descarta.
          const specifier = firstStringArgument(node)
          if (specifier !== undefined && specifier !== '') {
            out.imports.push({ specifier, bindings: [] })
          }
        } else if (callee.type === 'identifier' && callee.text === 'require') {
          const specifier = firstStringArgument(node)
          if (specifier !== undefined && specifier !== '') {
            out.imports.push({ specifier, bindings: [] })
          }
        } else {
          const reference = referenceOf(callee, current)
          if (reference !== undefined) out.calls.push(reference)
        }
      }
      break
    }
    case 'new_expression': {
      const constructor = node.childForFieldName('constructor')
      if (constructor !== null) {
        const reference = referenceOf(constructor, current)
        if (reference !== undefined) out.calls.push(reference)
      }
      break
    }
    default:
      break
  }

  for (const child of node.namedChildren) {
    walk(child, current, owners, out)
  }
}

export function parseEcmascript(parser: Parser, source: string): ParsedFile {
  const tree = parseSource(parser, source)
  const root = tree.rootNode
  const { symbols, owners, inherits } = collectTopLevel(root)
  const collected: Collected = { imports: [], calls: [], inherits: [...inherits] }
  walk(root, null, owners, collected)
  return {
    symbols,
    imports: collected.imports,
    calls: collected.calls,
    inherits: collected.inherits,
  }
}

/**
 * Resolucion de especificadores de Node/TypeScript. La politica completa esta
 * en `packages/graph/README.md`; en resumen:
 *
 *   1. Relativo (`./`, `../`) -> se normaliza contra el directorio del fichero
 *      y se prueban, EN ESTE ORDEN: la reescritura de extension de ESM
 *      (`./x.js` -> `x.ts`), la ruta tal cual, la ruta con cada extension
 *      conocida, y `ruta/index.<ext>`. La PRIMERA que exista en el repo gana.
 *      Si ninguna existe -> `unresolved` y NO se crea arista.
 *   2. Nudo (`pg`, `@coord/db`, `node:fs`) -> nodo `package`. El paquete existe
 *      de verdad como dependencia aunque su codigo no este en el repo; lo que
 *      no se hace es fingir que apunta a un fichero.
 *   3. `#interno` (imports map de package.json) -> `unresolved`: resolverlo
 *      exigiria leer e interpretar el package.json de cada paquete.
 */
export function resolveEcmascriptSpecifier(
  specifier: string,
  fromPath: string,
  files: RepoFileIndex,
): ResolvedSpecifier {
  if (specifier.startsWith('.')) {
    const target = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
    // `../..` desde la raiz se sale del repo: no hay fichero que valga.
    if (target === '..' || target.startsWith('../') || target === '.') return UNRESOLVED
    for (const candidate of relativeCandidates(target)) {
      if (files.has(candidate)) return { kind: 'file', path: candidate }
    }
    return UNRESOLVED
  }

  if (specifier.startsWith('#') || specifier === '') return UNRESOLVED

  return { kind: 'package', name: packageNameOf(specifier) }
}

function* relativeCandidates(target: string): Generator<string> {
  const extension = posix.extname(target)
  const rewrites = EXTENSION_REWRITES.get(extension)
  if (rewrites !== undefined) {
    const withoutExtension = target.slice(0, target.length - extension.length)
    for (const rewrite of rewrites) yield `${withoutExtension}${rewrite}`
  }
  yield target
  if (extension === '') {
    for (const candidate of EXTENSION_CANDIDATES) yield `${target}${candidate}`
  }
  for (const basename of INDEX_BASENAMES) {
    for (const candidate of EXTENSION_CANDIDATES) {
      yield `${target}/${basename}${candidate}`
    }
  }
}

/**
 * `@scope/pkg/sub` -> `@scope/pkg`; `lodash/merge` -> `lodash`; `node:fs` se
 * queda entero, porque el prefijo forma parte del nombre del builtin.
 */
function packageNameOf(specifier: string): string {
  if (specifier.startsWith('node:')) return specifier
  const segments = specifier.split('/')
  if (specifier.startsWith('@') && segments.length >= 2) {
    return `${segments[0] ?? ''}/${segments[1] ?? ''}`
  }
  return segments[0] ?? specifier
}
