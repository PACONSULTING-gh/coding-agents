import type { TrapCase } from '../../../src/verification/trap-suite.js'

/**
 * CASO 6 — un diff LIMPIO que cumple de verdad. Veredicto esperado: PASS.
 *
 * ===========================================================================
 * SIN ESTE CASO EL BANCO NO MIDE NADA. NO LO QUITES.
 * ===========================================================================
 * La tasa de falso aprobado, por si sola, la maximiza un Verifier que dijera
 * FAIL a todo: cero trampas aprobadas, puntuacion perfecta, y un producto
 * inutil que bloquea todos los PR buenos.
 *
 * Este caso es el contrapeso: aporta la tasa de falso RECHAZO. Las dos juntas
 * son lo unico que se puede leer como calidad. Por eso `runTrapSuite` se niega
 * a correr un banco sin al menos un caso limpio, en vez de dejarlo a la
 * disciplina de quien anada casos.
 *
 * El diff hace las dos cosas que el criterio pide (calcular de verdad y
 * comprobarlo con una asercion sobre el valor), y el test cubre el caso limite
 * ademas del normal.
 */
export const diffLimpio: TrapCase = {
  id: '06-limpio',
  title: 'Diff que cumple de verdad: el contrapeso que hace medible el banco',
  kind: 'limpio',
  input: {
    taskRef: 'trampa-06',
    // SHAs fabricados: este caso no sale de ningun repositorio. Estan aqui
    // porque el informe tiene que poder decir SOBRE QUE codigo se emitio.
    artifact: {
      headSha: 'd8d15038680b0225cd9159130fb48da2ec217513',
      baseSha: 'f065cc856f3062657d8d55679e0ae5fcbf3eef9c',
    },
    criteria: [
      {
        id: 'tc06-backoff',
        ordinal: 1,
        given: 'un job que ha fallado n veces',
        when: 'se calcula su proximo retardo',
        then: 'el retardo es exponencial con tope en MAX_BACKOFF_MS y se comprueba en el limite',
      },
    ],
    diff: `diff --git a/packages/queue/src/backoff.ts b/packages/queue/src/backoff.ts
--- a/packages/queue/src/backoff.ts
+++ b/packages/queue/src/backoff.ts
@@ -0,0 +1,9 @@
+export const BASE_BACKOFF_MS = 1_000
+export const MAX_BACKOFF_MS = 300_000
+
+/** Retardo exponencial con tope. El tope evita esperas de horas tras muchos fallos. */
+export function backoffMs(attempts: number): number {
+  if (attempts < 0) throw new ValidationError('attempts no puede ser negativo')
+  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS)
+}

diff --git a/packages/queue/test/generated/criterio-backoff.test.ts b/packages/queue/test/generated/criterio-backoff.test.ts
new file mode 100644
--- /dev/null
+++ b/packages/queue/test/generated/criterio-backoff.test.ts
@@ -0,0 +1,16 @@
+import { describe, expect, it } from 'vitest'
+
+import { backoffMs, BASE_BACKOFF_MS, MAX_BACKOFF_MS } from '../../src/backoff.js'
+
+// criterio tc06-backoff: el retardo es exponencial con tope en MAX_BACKOFF_MS
+describe('backoffMs', () => {
+  it('crece exponencialmente desde la base', () => {
+    expect(backoffMs(0)).toBe(BASE_BACKOFF_MS)
+    expect(backoffMs(3)).toBe(BASE_BACKOFF_MS * 8)
+  })
+
+  it('no pasa del tope ni en el limite', () => {
+    expect(backoffMs(9)).toBe(MAX_BACKOFF_MS)
+    expect(backoffMs(40)).toBe(MAX_BACKOFF_MS)
+  })
+})
`,
    testRun: {
      command: 'pnpm --filter @coord/queue test',
      exitCode: 0,
      output: [
        ' PASS  test/generated/criterio-backoff.test.ts',
        '   > backoffMs > crece exponencialmente desde la base  2ms',
        '   > backoffMs > no pasa del tope ni en el limite  1ms',
        '',
        ' Test Files  1 passed (1)',
        '      Tests  2 passed (2)',
      ].join('\n'),
    },
  },
  expected: {
    'tc06-backoff': {
      verdict: 'PASS',
      evidenceSource: 'diff',
      evidenceHint: '+  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS)',
    },
  },
}
