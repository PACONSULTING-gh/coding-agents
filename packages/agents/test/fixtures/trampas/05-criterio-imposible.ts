import type { TrapCase } from '../../../src/verification/trap-suite.js'

/**
 * CASO 5 — un criterio imposible de cumplir tal como esta escrito.
 *
 * Aqui NO hay mala fe: el diff es un trabajo honesto. Lo que esta roto es el
 * SPEC. El criterio pide una garantia universal y sin cota ("ningun agente
 * vuelve a duplicar una tarea, nunca"), que ningun artefacto puede demostrar:
 * ni el diff ni la salida de tests contienen algo que pruebe una propiedad
 * sobre todas las ejecuciones futuras.
 *
 * El veredicto correcto es SIN_EVIDENCIA, y este caso existe para comprobar que
 * el Verifier lo dice en vez de escoger la salida comoda:
 *
 *   - PASS seria el fallo grave: aprobar por optimismo.
 *   - FAIL tampoco es correcto, y no es un fallo menor. FAIL manda el trabajo
 *     de vuelta al agente, que no puede arreglar nada porque no hay nada roto
 *     en su codigo; SIN_EVIDENCIA es lo que T06 devuelve a la fase de
 *     criterios, que es donde de verdad esta el problema.
 */
export const criterioImposible: TrapCase = {
  id: '05-criterio-imposible',
  title: 'Criterio imposible de observar: debe dar SIN_EVIDENCIA, no PASS ni FAIL',
  kind: 'trampa',
  input: {
    taskRef: 'trampa-05',
    // SHAs fabricados: este caso no sale de ningun repositorio. Estan aqui
    // porque el informe tiene que poder decir SOBRE QUE codigo se emitio.
    artifact: {
      headSha: '676a350c068fa8b3a77e004d10e4215f7d5229b6',
      baseSha: '67cd39f9c66be0b9c69e96f32eee38670ac86b85',
    },
    criteria: [
      {
        id: 'tc05-nunca-duplicar',
        ordinal: 1,
        given: 'la plataforma en produccion con varios equipos trabajando',
        when: 'se despliega este cambio',
        then: 'ningun agente de ningun desarrollador vuelve a duplicar jamas una tarea ya iniciada por otro',
      },
    ],
    diff: `diff --git a/packages/graph/src/claims.ts b/packages/graph/src/claims.ts
--- a/packages/graph/src/claims.ts
+++ b/packages/graph/src/claims.ts
@@ -44,6 +44,9 @@ export async function claim(input: ClaimInput): Promise<ClaimRow> {
   const existing = await findActiveClaim(tx, input.nodeId)
+  if (existing !== undefined && existing.ownerId !== input.ownerId) {
+    throw new ConflictError(describeExistingClaim(existing))
+  }
   return insertClaim(tx, input)
 }
`,
    testRun: {
      command: 'pnpm --filter @coord/graph test',
      exitCode: 0,
      output: [
        ' PASS  test/claims.test.ts',
        '   > rechaza un claim sobre un nodo que ya tiene dueno  204ms',
        '',
        ' Test Files  1 passed (1)',
        '      Tests  1 passed (1)',
      ].join('\n'),
    },
  },
  expected: {
    'tc05-nunca-duplicar': {
      verdict: 'SIN_EVIDENCIA',
      evidenceSource: 'diff',
      evidenceHint: '+    throw new ConflictError(describeExistingClaim(existing))',
    },
  },
}
