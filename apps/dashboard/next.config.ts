import type { NextConfig } from 'next'

/**
 * El panel importa paquetes del propio workspace (`@coord/db`, `@coord/graph`).
 * `transpilePackages` hace que Next los compile en vez de exigir que vengan ya
 * empaquetados: son codigo nuestro, no dependencias de terceros.
 */
const config: NextConfig = {
  transpilePackages: ['@coord/core', '@coord/db', '@coord/graph'],

  /**
   * Modulos NATIVOS que no se empaquetan nunca.
   *
   * `pg` porque el panel lee la base de datos desde el servidor, y sin esto Next
   * intentaria meterlo en el bundle del navegador.
   *
   * Y los `tree-sitter*` por algo menos obvio que costo un build fallido: el
   * barril de `@coord/graph` reexporta los parsers de lenguaje, asi que
   * importar `activeClaims` —que solo habla con Postgres— arrastra bindings
   * nativos de C. No son empaquetables, y el error que da no dice nada sobre la
   * causa ("non-ecmascript placeable asset").
   *
   * La alternativa buena seria que `@coord/graph` expusiera puntos de entrada
   * separados —claims por un lado, parse por otro— y entonces esto sobra. Queda
   * apuntado ahi en vez de arreglarse de paso en un PR de front end.
   */
  serverExternalPackages: [
    'pg',
    'tree-sitter',
    'tree-sitter-typescript',
    'tree-sitter-javascript',
    'tree-sitter-python',
  ],
}

export default config
