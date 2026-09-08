import type Parser from 'tree-sitter'

/**
 * Envoltura obligatoria de `Parser.parse`. **No llames a `parser.parse` directo.**
 *
 * El binding nativo de tree-sitter 0.21 reserva un buffer de 32 KiB por defecto y,
 * a partir de 32.768 caracteres, lanza `Invalid argument` — un error del binding,
 * sin fichero ni posicion, que no dice nada de lo que pasa. Medido en los tres
 * lenguajes: 32.767 caracteres pasan, 32.768 falla.
 *
 * Un fichero de ese tamano no es raro: `packages/graph/src/claims.ts`, de este
 * mismo epic, tiene 34.665 bytes. Sin esta envoltura, indexar este repo aborta la
 * ingesta entera en cuanto ese fichero entra en el indice de git.
 *
 * **Por que no se baja `maxFileBytes` a 32 KiB:** porque no arregla nada. El
 * fichero se saltaria en silencio, el grafo perderia sus aristas, y `blast_radius`
 * responderia con menos afectados de los reales sin decir que le falta informacion.
 * Un grafo que miente por omision es peor que una ingesta que falla ruidosamente.
 * `maxFileBytes` sigue existiendo para su proposito real: no intentar parsear un
 * blob de varios megas.
 *
 * El coste es una reserva proporcional al fichero, no una copia extra: el buffer se
 * dimensiona en bytes UTF-8 (no en caracteres) porque el binding cuenta bytes, y un
 * fichero con acentos o CJK ocupa mas de lo que sugiere `source.length`.
 */
export function parseSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse(source, undefined, {
    bufferSize: Buffer.byteLength(source, 'utf8') + 1024,
  })
}
