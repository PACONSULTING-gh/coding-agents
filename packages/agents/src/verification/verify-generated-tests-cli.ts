import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  GENERATED_TESTS_MANIFEST_PATH,
  GENERATED_TESTS_SIGNING_KEY_ENV,
  describeFinding,
} from './test-manifest.js'
import { readSigningKeyFromEnv, verifyGeneratedTestsOnDisk } from './generated-tests-fs.js'

/**
 * CLI que comprueba el arbol de tests generados contra su manifiesto.
 *
 * ES LO QUE BLOQUEA. Sale con codigo 1 si algo no cuadra, y ese codigo es lo
 * que hace fallar el job de CI (T03 lo engancha en `.github/workflows/`).
 *
 * Uso:
 *   pnpm --filter @coord/agents verify:generated-tests [--root <ruta>]
 *
 * Sin `--root` se sube desde el cwd hasta el `pnpm-workspace.yaml`, asi que
 * funciona igual desde la raiz que desde el paquete.
 *
 * No toca la base de datos a proposito: el runner de CI no tiene Postgres. El
 * registro del intento en `audit_log` lo hace `tamper-audit.ts`, desde el lado
 * que si tiene contexto de tenant.
 */

async function findWorkspaceRoot(from: string): Promise<string> {
  // Se sube buscando el `pnpm-workspace.yaml`. Hace falta porque el uso normal
  // es `pnpm --filter @coord/agents verify:generated-tests`, y pnpm arranca el
  // script con el cwd en packages/agents: sin esto, el gate escanearia el
  // paquete en vez del repositorio y daria verde sin haber mirado nada.
  let current = resolve(from)
  for (;;) {
    try {
      await access(join(current, 'pnpm-workspace.yaml'))
      return current
    } catch {
      // Cualquier fallo al mirar el fichero significa lo mismo para esta sonda:
      // aqui no esta, sigue subiendo. No se traga ningun error de la
      // comprobacion en si, que va mas abajo y propaga.
      const parent = dirname(current)
      if (parent === current) return resolve(from)
      current = parent
    }
  }
}

async function parseRoot(argv: readonly string[]): Promise<string> {
  const index = argv.indexOf('--root')
  if (index === -1) return findWorkspaceRoot(process.cwd())
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error('`--root` necesita una ruta.')
  }
  return resolve(value)
}

const repoRoot = await parseRoot(process.argv.slice(2))
const signingKey = readSigningKeyFromEnv()
const verification = await verifyGeneratedTestsOnDisk({ repoRoot, signingKey })

if (!verification.manifestPresent && verification.ok) {
  console.log(
    `No hay ${GENERATED_TESTS_MANIFEST_PATH}: todavia no se ha generado ningun test. Nada que comprobar.`,
  )
  process.exit(0)
}

if (!verification.signatureChecked) {
  // Se dice SIEMPRE y en voz alta. Un manifiesto sin firma comprobada protege
  // del descuido, no de un agente: quien reescribe un test puede reescribir sus
  // hashes. Callarselo convertiria este gate en uno de esos que parecen puestos
  // y no lo estan.
  console.warn(
    `AVISO: firma NO comprobada (falta ${GENERATED_TESTS_SIGNING_KEY_ENV}). Los hashes cuadran, ` +
      'pero eso no demuestra que nadie haya tocado los tests: sin clave, quien reescriba un ' +
      'test puede reescribir tambien el manifiesto. Configura la clave en el CI.',
  )
}

if (verification.ok) {
  console.log(
    `Tests generados: ${String(verification.filesChecked)} fichero(s) cuadran con ` +
      `${GENERATED_TESTS_MANIFEST_PATH}.`,
  )
  process.exit(0)
}

console.error(
  `Los tests generados no cuadran con ${GENERATED_TESTS_MANIFEST_PATH} ` +
    `(${String(verification.findings.length)} hallazgo(s)):`,
)
for (const finding of verification.findings) {
  console.error(`  - ${describeFinding(finding)}`)
}
console.error('')
console.error(
  'El arbol `test/generated/` es propiedad del generador de tests (T02, epic 05). Nadie lo ' +
    'edita a mano: se regenera desde los criterios de aceptacion.',
)
process.exit(1)
