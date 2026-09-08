import Parser from 'tree-sitter'
import TypeScriptLanguages from 'tree-sitter-typescript'

import { parseEcmascript, resolveEcmascriptSpecifier } from './ecmascript.js'
import type { LanguageParser, ParsedFile, RepoFileIndex, ResolvedSpecifier } from './types.js'

/**
 * TypeScript, incluido TSX.
 *
 * Son dos gramaticas distintas y no son intercambiables: en `.tsx` el `<` de
 * un elemento JSX choca con las aserciones de tipo, asi que parsear un `.tsx`
 * con la gramatica de TypeScript da un arbol lleno de nodos ERROR y se pierden
 * imports. Se elige por extension.
 *
 * Los dos `Parser` se crean UNA vez y se reutilizan: instanciarlos carga un
 * modulo nativo, y hacerlo por fichero domina el tiempo de una ingesta
 * completa. `parse()` es sincrono, asi que no hay dos parseos a la vez sobre el
 * mismo objeto por mucho que el motor lance los lotes con `p-limit`.
 */
let typescriptParser: Parser | undefined
let tsxParser: Parser | undefined

const TSX_EXTENSIONS = new Set(['.tsx'])

function parserFor(path: string): Parser {
  if (TSX_EXTENSIONS.has(extensionOf(path))) {
    tsxParser ??= createParser(TypeScriptLanguages.tsx)
    return tsxParser
  }
  typescriptParser ??= createParser(TypeScriptLanguages.typescript)
  return typescriptParser
}

function createParser(language: unknown): Parser {
  const parser = new Parser()
  parser.setLanguage(language)
  return parser
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.')
  return index === -1 ? '' : path.slice(index).toLowerCase()
}

export const typescriptLanguageParser: LanguageParser = {
  language: 'typescript',
  extensions: ['.ts', '.tsx', '.mts', '.cts'],
  parse(source: string, path: string): ParsedFile {
    return parseEcmascript(parserFor(path), source)
  },
  resolveSpecifier(specifier: string, fromPath: string, files: RepoFileIndex): ResolvedSpecifier {
    return resolveEcmascriptSpecifier(specifier, fromPath, files)
  },
}
