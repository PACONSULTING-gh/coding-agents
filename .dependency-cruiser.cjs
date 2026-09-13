/**
 * Fitness functions de arquitectura (CLAUDE.md 5, docs/quality-gates.md).
 *
 * ---------------------------------------------------------------------------
 * POR QUE `tsconfig.depcruise.json` Y NO EL `tsconfig.json` DE LA RAIZ
 * ---------------------------------------------------------------------------
 * LEE ESTO ANTES DE TOCAR `options`.
 *
 * Los paquetes del workspace se importan por su nombre (`@coord/db`), y su
 * `exports` apunta a `dist/index.js`. Con el tsconfig de la raiz, depcruise
 * resolvia esas aristas a `packages/*\/dist/...` — que el `exclude` borraba del
 * grafo — o directamente no las resolvia (`couldNotResolve`), y una regla no
 * puede disparar sobre una arista que no ve. Resultado: `core-no-sale` daba
 * verde con `import ... from '@coord/db'` dentro de packages/core, que es
 * EXACTAMENTE la violacion que debe bloquear.
 *
 * `tsconfig.depcruise.json` mapea `@coord/*` a `packages/*\/src/index.ts`, asi
 * que depcruise ve el codigo fuente de los paquetes hermanos y las reglas
 * disparan. Ese tsconfig no lo usa ni el build ni el runtime: es solo para el
 * analisis estatico.
 *
 * ---------------------------------------------------------------------------
 * POR QUE LOS PATRONES DE PAQUETES NPM NO LLEVAN `^`
 * ---------------------------------------------------------------------------
 * Bajo pnpm la ruta resuelta de una dependencia es
 * `node_modules/.pnpm/pg@8.23.0/node_modules/pg/esm/index.mjs`, no
 * `node_modules/pg/...`. Un patron anclado con `^(node_modules/)?pg` no casa
 * nunca y la regla queda inerte. Por eso se busca el segmento
 * `/node_modules/<paquete>/`, que aparece en ambos layouts.
 *
 * Cada una de estas reglas se ha validado introduciendo a proposito la
 * violacion que dice prohibir y comprobando que `pnpm arch` sale con codigo 1.
 */
const NODE_MODULES = '(^|/)node_modules/'

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        'Un import que no resuelve es un agujero en el analisis: ninguna otra regla puede ' +
        'evaluarlo, asi que pasaria en silencio. Falla ruidosamente (CLAUDE.md 5).',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Sin ciclos entre modulos (CLAUDE.md 5).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-no-sale',
      severity: 'error',
      comment:
        'packages/core es el dominio: no puede depender de infraestructura ni de apps (CLAUDE.md 3, dependencias apuntan hacia dentro).',
      from: { path: '^packages/core' },
      to: { path: '^(apps|packages/(db|queue|github|graph|agents))' },
    },
    {
      name: 'pg-boss-solo-en-queue',
      severity: 'error',
      comment: 'pg-boss es un detalle de implementacion de packages/queue, oculto tras QueuePort.',
      from: { pathNot: '^packages/queue' },
      to: { path: `${NODE_MODULES}pg-boss(/|$)` },
    },
    {
      name: 'anthropic-sdk-solo-en-agents',
      severity: 'error',
      comment:
        'El SDK de Anthropic es el detalle de implementacion de packages/agents, oculto tras ' +
        'LlmPort (packages/core/src/ports/llm.ts). Mismo principio que pg-boss-solo-en-queue: ' +
        'el proveedor de LLM tiene que ser reemplazable, y no lo es si el epic 05 entero ' +
        '(generador de tests, Verifier, informe) importa el SDK directamente.',
      from: { pathNot: '^packages/agents' },
      to: { path: `${NODE_MODULES}@anthropic-ai/sdk(/|$)` },
    },
    {
      name: 'pg-solo-en-db',
      severity: 'error',
      comment: 'El acceso directo a Postgres vive solo en packages/db.',
      from: { pathNot: '^packages/db' },
      to: { path: `${NODE_MODULES}pg(/|$)` },
    },
    {
      name: 'tree-sitter-solo-en-graph',
      severity: 'error',
      comment:
        'tree-sitter y sus gramaticas son modulos NATIVOS y son el detalle de implementacion ' +
        'de la ingesta del grafo (epic 02, T02). Fuera de packages/graph nadie parsea codigo: ' +
        'quien necesite estructura del codigo pregunta al grafo, no vuelve a parsear el repo.',
      from: { pathNot: '^packages/graph' },
      // `tree-sitter[^/]*` casa con la runtime y con todas las gramaticas
      // (`tree-sitter-typescript`, `-python`, ...). No se escribe
      // `tree-sitter(-[^/]+)?` porque dependency-cruiser rechaza ese patron por
      // ReDoS (cuantificador anidado) y se niega a correr: la regla no quedaria
      // laxa, quedaria INEXISTENTE.
      to: { path: `${NODE_MODULES}tree-sitter[^/]*(/|$)` },
    },
    {
      name: 'mcp-sdk-solo-en-graph-mcp',
      severity: 'error',
      comment:
        'El SDK de MCP es el transporte de las herramientas del grafo (epic 02, T05) y vive ' +
        'solo en packages/graph/{src,test}/mcp/. La logica de consulta (queries.ts, claims.ts) ' +
        'no puede depender de como se expone: si se acopla, exponerla por otra via obliga a ' +
        'reescribirla. test/mcp/ tiene el mismo permiso que src/mcp/ (y solo ese subdirectorio, ' +
        'no el resto de test/) porque el criterio de aceptacion de T05 exige arrancar el servidor ' +
        'de verdad y hablarle por stdio con el CLIENTE del SDK, no solo probar las funciones ' +
        'internas.',
      from: { pathNot: '^packages/graph/(src|test)/mcp/' },
      to: { path: `${NODE_MODULES}@modelcontextprotocol/sdk(/|$)` },
    },
    {
      name: 'octokit-solo-en-github',
      severity: 'error',
      comment:
        'El cliente de la GitHub App y octokit son un detalle de implementacion de packages/github.',
      from: { pathNot: '^packages/github' },
      to: { path: `${NODE_MODULES}(@octokit/[^/]+|octokit)(/|$)` },
    },
    {
      name: 'generador-de-tests-no-lee-del-disco',
      severity: 'error',
      comment:
        'El primer criterio de aceptacion de T02 (epic 05) dice que el agente generador de ' +
        'tests NO HA VISTO la implementacion, y eso solo se cumple por construccion si el ' +
        'modulo no tiene NINGUNA via para leerla. La cabecera de test-generator.ts lo afirma; ' +
        'esta regla es lo que lo hace cumplir. Prohibido node:fs, node:fs/promises y ' +
        'node:child_process, y prohibido importar generated-tests-fs.ts (que si toca el disco). ' +
        'verifier.ts va en la misma lista por el mismo motivo: su aislamiento (primer criterio ' +
        'de T04) se cae en cuanto pueda ir a buscar contexto por su cuenta.',
      from: {
        path: '^packages/agents/src/verification/(test-generator|verifier)\\.ts$',
      },
      to: {
        path:
          '^(node:)?(fs|fs/promises|child_process)$' +
          '|^packages/agents/src/verification/generated-tests-fs\\.ts$',
      },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Modulo huerfano: nadie lo importa. Puede ser codigo muerto (revisar, no bloquea).',
      from: {
        orphan: true,
        // Los tests no los importa nadie por definicion, y los ficheros de
        // configuracion (vitest.config.ts, eslint.config.mjs...) los carga la
        // herramienta, no un import. Avisar de ellos es ruido fijo que la gente
        // aprende a ignorar, justo lo que docs/quality-gates.md quiere evitar.
        pathNot: '(\\.(test|spec)\\.(ts|tsx|js)$|\\.config\\.(ts|js|mjs|cjs)$)',
      },
      to: {},
    },
    {
      name: 'no-deprecated-core',
      severity: 'warn',
      comment: 'Uso de una API marcada @deprecated en el core del lenguaje o de node.',
      from: {},
      to: { dependencyTypes: ['deprecated'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Acotado a la salida de build de los paquetes del workspace. Un `dist/`
    // global tambien borraba del grafo cualquier dependencia npm servida desde
    // un `dist/`, y con ella la posibilidad de que una regla la evaluase.
    exclude: { path: '^(packages|apps)/[^/]+/(dist|\\.next)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
}
