import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'

import { parseEcmascript, resolveEcmascriptSpecifier } from './ecmascript.js'
import type { LanguageParser, ParsedFile, RepoFileIndex, ResolvedSpecifier } from './types.js'

/**
 * JavaScript (incluido JSX, que la gramatica de JavaScript ya cubre).
 *
 * La extraccion y la resolucion son las mismas que en TypeScript —es la misma
 * familia de modulos— y viven en `ecmascript.ts`. Este modulo solo elige
 * gramatica y extensiones, que es exactamente lo que debe costar anadir un
 * lenguaje.
 */
let parser: Parser | undefined

function javascriptParser(): Parser {
  if (parser === undefined) {
    parser = new Parser()
    parser.setLanguage(JavaScript)
  }
  return parser
}

export const javascriptLanguageParser: LanguageParser = {
  language: 'javascript',
  extensions: ['.js', '.jsx', '.mjs', '.cjs'],
  parse(source: string): ParsedFile {
    return parseEcmascript(javascriptParser(), source)
  },
  resolveSpecifier(specifier: string, fromPath: string, files: RepoFileIndex): ResolvedSpecifier {
    return resolveEcmascriptSpecifier(specifier, fromPath, files)
  },
}
