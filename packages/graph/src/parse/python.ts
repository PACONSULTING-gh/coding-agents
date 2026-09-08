import posix from 'node:path/posix'

import Parser from 'tree-sitter'
import Python from 'tree-sitter-python'

import type {
  ImportBinding,
  LanguageParser,
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

type SyntaxNode = Parser.SyntaxNode

/**
 * Python.
 *
 * Mismo contrato que los otros parsers; lo que cambia de verdad es la
 * resolucion de modulos, que en Python no tiene nada que ver con la de Node:
 * los puntos iniciales cuentan niveles de paquete y un modulo puede ser un
 * fichero `x.py` o un paquete `x/__init__.py`.
 */
let parser: Parser | undefined

function pythonParser(): Parser {
  if (parser === undefined) {
    parser = new Parser()
    parser.setLanguage(Python)
  }
  return parser
}

const DEFINITION_KINDS = new Map<string, SymbolKind>([
  ['function_definition', 'function'],
  ['class_definition', 'class'],
])

function referenceOf(node: SyntaxNode, from: string | null): ParsedReference | undefined {
  if (node.type === 'identifier') {
    return { from, name: node.text, namespace: null }
  }
  if (node.type === 'attribute') {
    const object = node.childForFieldName('object')
    const attribute = node.childForFieldName('attribute')
    if (attribute === null) return undefined
    // Solo un nivel: `os.path.join()` no se resuelve, y no se inventa.
    if (object === null || object.type !== 'identifier') return undefined
    return { from, name: attribute.text, namespace: object.text }
  }
  return undefined
}

/** Desenvuelve `@decorador` para llegar a la definicion que decora. */
function undecorated(node: SyntaxNode): SyntaxNode {
  return node.type === 'decorated_definition'
    ? (node.childForFieldName('definition') ?? node)
    : node
}

function collectTopLevel(module: SyntaxNode): {
  symbols: ParsedSymbol[]
  owners: Map<number, string>
  inherits: ParsedReference[]
} {
  const symbols: ParsedSymbol[] = []
  const seen = new Set<string>()
  const owners = new Map<number, string>()
  const inherits: ParsedReference[] = []

  for (const statement of module.namedChildren) {
    const definition = undecorated(statement)
    const symbolKind = DEFINITION_KINDS.get(definition.type)
    if (symbolKind === undefined) continue
    const name = definition.childForFieldName('name')
    if (name === null || seen.has(name.text)) continue
    seen.add(name.text)
    symbols.push({ name: name.text, symbolKind })
    owners.set(definition.id, name.text)

    const superclasses = definition.childForFieldName('superclasses')
    if (superclasses === null) continue
    for (const base of superclasses.namedChildren) {
      const reference = referenceOf(base, name.text)
      if (reference !== undefined) inherits.push(reference)
    }
  }

  return { symbols, owners, inherits }
}

function bindingsOfNames(names: readonly SyntaxNode[], relativeToDots: boolean): ImportBinding[] {
  const bindings: ImportBinding[] = []
  for (const node of names) {
    if (node.type === 'aliased_import') {
      const name = node.childForFieldName('name')
      const alias = node.childForFieldName('alias')
      if (name === null || alias === null) continue
      bindings.push({
        local: alias.text,
        // `import a.b as ab` liga un MODULO, no un simbolo: es un namespace.
        imported: relativeToDots ? null : lastSegment(name.text),
        kind: relativeToDots ? 'namespace' : 'named',
      })
      continue
    }
    if (node.type === 'dotted_name') {
      const text = node.text
      bindings.push(
        relativeToDots
          ? { local: text, imported: null, kind: 'namespace' }
          : { local: lastSegment(text), imported: lastSegment(text), kind: 'named' },
      )
    }
  }
  return bindings
}

function lastSegment(dotted: string): string {
  const segments = dotted.split('.')
  return segments[segments.length - 1] ?? dotted
}

function collectImports(node: SyntaxNode, out: ParsedImport[]): void {
  if (node.type === 'import_statement') {
    // `import a.b` / `import a.b as ab`: el nombre ligado es el modulo entero.
    for (const child of node.namedChildren) {
      if (child.type === 'aliased_import') {
        const name = child.childForFieldName('name')
        const alias = child.childForFieldName('alias')
        if (name === null || alias === null) continue
        out.push({
          specifier: name.text,
          bindings: [{ local: alias.text, imported: null, kind: 'namespace' }],
        })
        continue
      }
      if (child.type === 'dotted_name') {
        out.push({
          specifier: child.text,
          // `import a.b` liga `a`, no `a.b`: por `a.b.foo()` no se resuelve nada
          // (dos niveles), asi que no se declara ninguna ligadura util.
          bindings: [],
        })
      }
    }
    return
  }

  if (node.type !== 'import_from_statement') return
  const moduleName = node.childForFieldName('module_name')
  if (moduleName === null) return
  const names = node.namedChildren.filter(
    (child) => child.id !== moduleName.id && child.type !== 'wildcard_import',
  )

  // `from . import x` / `from .. import x`: lo que se importa NO es un simbolo
  // del paquete, es el modulo `x` dentro de el. Se emite un import por nombre
  // apuntando al modulo, que es lo que de verdad se depende.
  if (/^\.+$/.test(moduleName.text)) {
    for (const binding of bindingsOfNames(names, true)) {
      out.push({
        specifier: `${moduleName.text}${binding.local}`,
        bindings: [binding],
      })
    }
    if (names.length === 0) out.push({ specifier: moduleName.text, bindings: [] })
    return
  }

  out.push({ specifier: moduleName.text, bindings: bindingsOfNames(names, false) })
}

function walk(
  node: SyntaxNode,
  owner: string | null,
  owners: ReadonlyMap<number, string>,
  imports: ParsedImport[],
  calls: ParsedReference[],
): void {
  const current = owners.get(node.id) ?? owner

  if (node.type === 'import_statement' || node.type === 'import_from_statement') {
    collectImports(node, imports)
    return
  }

  if (node.type === 'call') {
    const callee = node.childForFieldName('function')
    if (callee !== null) {
      const reference = referenceOf(callee, current)
      if (reference !== undefined) calls.push(reference)
    }
  }

  for (const child of node.namedChildren) {
    walk(child, current, owners, imports, calls)
  }
}

export const pythonLanguageParser: LanguageParser = {
  language: 'python',
  extensions: ['.py', '.pyi'],

  parse(source: string): ParsedFile {
    const root = parseSource(pythonParser(), source).rootNode
    const { symbols, owners, inherits } = collectTopLevel(root)
    const imports: ParsedImport[] = []
    const calls: ParsedReference[] = []
    walk(root, null, owners, imports, calls)
    return { symbols, imports, calls, inherits }
  },

  /**
   * Resolucion de modulos de Python:
   *
   *   1. Relativo (`.mod`, `..pkg.sub`): el numero de puntos indica cuantos
   *      niveles de paquete subir desde el directorio del fichero. Se prueba
   *      `base/parts.py` y `base/parts/__init__.py`.
   *   2. Absoluto (`pkg.mod`): las mismas dos formas, desde la RAIZ del repo.
   *      No se buscan otras raices de fuentes (`src/`, `PYTHONPATH`...):
   *      adivinarlas produciria aristas a ficheros que quiza no son ese modulo.
   *   3. Si no existe ninguna, es un paquete externo (stdlib incluida) y se
   *      representa como nodo `package` con el PRIMER segmento del nombre, que
   *      es el paquete distribuible. `os.path` es el paquete `os`.
   */
  resolveSpecifier(specifier: string, fromPath: string, files: RepoFileIndex): ResolvedSpecifier {
    const dots = /^\.+/.exec(specifier)?.[0].length ?? 0
    const moduleName = specifier.slice(dots)
    const segments = moduleName === '' ? [] : moduleName.split('.')
    if (segments.some((segment) => segment === '')) return UNRESOLVED

    if (dots > 0) {
      let base = posix.dirname(fromPath)
      for (let level = 1; level < dots; level += 1) {
        if (base === '.' || base === '') return UNRESOLVED
        base = posix.dirname(base)
      }
      const prefix = base === '.' ? '' : `${base}/`
      for (const candidate of moduleCandidates(`${prefix}${segments.join('/')}`)) {
        if (files.has(candidate)) return { kind: 'file', path: candidate }
      }
      return UNRESOLVED
    }

    if (segments.length === 0) return UNRESOLVED
    for (const candidate of moduleCandidates(segments.join('/'))) {
      if (files.has(candidate)) return { kind: 'file', path: candidate }
    }
    return { kind: 'package', name: segments[0] ?? moduleName }
  },
}

function moduleCandidates(base: string): readonly string[] {
  const normalized = base.endsWith('/') ? base.slice(0, -1) : base
  if (normalized === '') return ['__init__.py']
  return [`${normalized}.py`, `${normalized}/__init__.py`, `${normalized}.pyi`]
}
