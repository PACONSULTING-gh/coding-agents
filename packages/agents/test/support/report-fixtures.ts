import type { LlmUsage } from '@coord/core'

import type {
  CriterionVerdict,
  CriterionVerdictValue,
  VerificationResult,
  VerifiedArtifact,
} from '../../src/verification/verifier.js'

/**
 * Fabricas de datos para los tests de T05 (`report.test.ts`,
 * `report-render.test.ts`). No pretenden ser el `VerificationResult` que
 * devolveria de verdad `verifyChanges` de T04 —eso ya lo prueba
 * `verifier.test.ts` contra el doble de Anthropic— sino formas validas y
 * controlables para probar la CONSTRUCCION DEL INFORME y sus dos
 * renderizados, con textos de tamaño conocido para poder razonar sobre el
 * presupuesto de pantalla.
 */

/** SHAs fabricados con la forma real: el informe tiene que poder nombrar su artefacto. */
export const SAMPLE_ARTIFACT: VerifiedArtifact = {
  headSha: '9f1c2b3a4d5e6f708192a3b4c5d6e7f809a1b2c3',
  baseSha: '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d',
}

export const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
}

export function makeVerdict(
  ordinal: number,
  verdict: CriterionVerdictValue,
  overrides: Partial<CriterionVerdict> = {},
): CriterionVerdict {
  const id = `criterion-${String(ordinal)}`
  return {
    criterionId: id,
    reasoning:
      `Razonamiento del criterio ${String(ordinal)}: el diff toca la ruta esperada y la salida ` +
      `de tests confirma el comportamiento pedido, sin señales de las trampas conocidas.`,
    criterionQuote: `Dado el estado inicial del criterio ${String(ordinal)}, cuando ocurre el evento`,
    evidenceSource: 'diff',
    evidenceQuote: `+ el fragmento de diff que sostiene el veredicto del criterio ${String(ordinal)}`,
    verdict,
    ...overrides,
  }
}

/**
 * `count` veredictos con `failCount` FAIL y `noEvidenceCount` SIN_EVIDENCIA,
 * REPARTIDOS POR TODO EL RANGO, y el resto en PASS.
 *
 * El reparto importa y antes no era el que decia el comentario: con `i % 3` los
 * seis no-PASS de la fixture de 40 caian TODOS en los diez primeros ordinales,
 * asi que el test del truncado nunca ejercitaba un FAIL al final. Ahora se
 * colocan en posiciones espaciadas por todo el rango (el ultimo FAIL cae
 * siempre en el ULTIMO ordinal), que es lo que hace falta para comprobar que el
 * truncado no depende de la posicion.
 */
export function makeVerdicts(
  count: number,
  options: { failCount?: number; noEvidenceCount?: number } = {},
): CriterionVerdict[] {
  const failCount = options.failCount ?? 0
  const noEvidenceCount = options.noEvidenceCount ?? 0
  if (failCount + noEvidenceCount > count) {
    throw new Error('makeVerdicts: mas no-PASS que criterios')
  }

  // Posiciones espaciadas por todo el rango. Se reservan de atras hacia
  // delante para que el ULTIMO ordinal sea siempre un no-PASS cuando lo haya.
  const kinds: CriterionVerdictValue[] = Array.from({ length: count }, () => 'PASS')
  const total = failCount + noEvidenceCount
  const step = total > 0 ? Math.floor(count / total) : 0
  for (let n = 0; n < total; n += 1) {
    const index = count - 1 - n * step
    kinds[index] = n < failCount ? 'FAIL' : 'SIN_EVIDENCIA'
  }

  return kinds.map((kind, index) => makeVerdict(index + 1, kind))
}

export function makeVerificationResult(
  verdicts: readonly CriterionVerdict[],
  overrides: Partial<VerificationResult> = {},
): VerificationResult {
  return {
    taskRef: 'issue-25',
    artifact: SAMPLE_ARTIFACT,
    model: 'claude-opus-5',
    verdicts,
    usage: ZERO_USAGE,
    ...overrides,
  }
}
