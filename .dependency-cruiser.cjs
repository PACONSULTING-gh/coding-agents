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
      to: { path: '^(apps|packages/(db|queue|github))' },
    },
    {
      name: 'pg-boss-solo-en-queue',
      severity: 'error',
      comment: 'pg-boss es un detalle de implementacion de packages/queue, oculto tras QueuePort.',
      from: { pathNot: '^packages/queue' },
      to: { path: `${NODE_MODULES}pg-boss(/|$)` },
    },
    {
      name: 'pg-solo-en-db',
      severity: 'error',
      comment: 'El acceso directo a Postgres vive solo en packages/db.',
      from: { pathNot: '^packages/db' },
      to: { path: `${NODE_MODULES}pg(/|$)` },
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
    exclude: { path: '^(packages|apps)/[^/]+/dist/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
}
