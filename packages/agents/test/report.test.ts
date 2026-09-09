import { describe, expect, it } from 'vitest'

import { buildConformanceReport, countVerdicts } from '../src/verification/report.js'
import {
  makeVerdict,
  makeVerificationResult,
  SAMPLE_ARTIFACT,
  ZERO_USAGE,
} from './support/report-fixtures.js'

/**
 * T05 — la estructura del informe: el veredicto global binario y que no se
 * pierda ni un campo de lo que dijo el Verifier (T04).
 */

describe('buildConformanceReport: veredicto global binario', () => {
  it('es "apto" cuando todos los criterios son PASS', () => {
    const result = makeVerificationResult([
      makeVerdict(1, 'PASS'),
      makeVerdict(2, 'PASS'),
      makeVerdict(3, 'PASS'),
    ])

    expect(buildConformanceReport(result).globalVerdict).toBe('apto')
  })

  it('un solo FAIL entre PASS hace el conjunto "no_apto"', () => {
    const result = makeVerificationResult([
      makeVerdict(1, 'PASS'),
      makeVerdict(2, 'FAIL'),
      makeVerdict(3, 'PASS'),
    ])

    expect(buildConformanceReport(result).globalVerdict).toBe('no_apto')
  })

  it('un solo SIN_EVIDENCIA entre PASS hace el conjunto "no_apto"', () => {
    const result = makeVerificationResult([
      makeVerdict(1, 'PASS'),
      makeVerdict(2, 'PASS'),
      makeVerdict(3, 'SIN_EVIDENCIA'),
    ])

    expect(buildConformanceReport(result).globalVerdict).toBe('no_apto')
  })

  /**
   * La version anterior de este test era `expect(Object.keys(report)).not.toContain('score')`,
   * que solo vigila UNA palabra: un campo llamado `puntuacion`, `rating` o
   * `percentage` la pasaba sin enterarse. Se fija el conjunto EXACTO de claves,
   * que falla ante cualquier campo nuevo — se llame como se llame — y obliga a
   * pasar por aqui a quien quiera anadir uno.
   */
  it('no es una puntuacion: el informe tiene exactamente estas claves y ninguna mas', () => {
    const result = makeVerificationResult([makeVerdict(1, 'PASS')])
    const report = buildConformanceReport(result)

    expect(Object.keys(report).sort()).toEqual([
      'artifact',
      'globalVerdict',
      'model',
      'taskRef',
      'usage',
      'verdicts',
    ])
    expect(['apto', 'no_apto']).toContain(report.globalVerdict)
  })

  it('el informe dice sobre QUE commit se emitio', () => {
    const report = buildConformanceReport(makeVerificationResult([makeVerdict(1, 'PASS')]))
    // Sin esto, un "APTO" pegado en un PR no dice a que diff se refiere y sigue
    // pareciendo vigente despues de tres commits mas.
    expect(report.artifact).toEqual(SAMPLE_ARTIFACT)
  })
})

describe('buildConformanceReport: nada se pierde entre el veredicto de T04 y el informe', () => {
  it('copia cada veredicto campo a campo, en el mismo orden', () => {
    const verdicts = [
      makeVerdict(1, 'PASS'),
      makeVerdict(2, 'FAIL', { evidenceSource: 'test_output' }),
      makeVerdict(3, 'SIN_EVIDENCIA'),
    ]
    const result = makeVerificationResult(verdicts)

    const report = buildConformanceReport(result)

    expect(report.verdicts).toHaveLength(verdicts.length)
    verdicts.forEach((expected, index) => {
      expect(report.verdicts[index]).toEqual(expected)
    })
  })

  it('conserva taskRef, model y usage del resultado original', () => {
    const usage = { ...ZERO_USAGE, inputTokens: 1234, outputTokens: 567 }
    const result = makeVerificationResult([makeVerdict(1, 'PASS')], {
      taskRef: 'issue-99',
      model: 'claude-opus-5',
      usage,
    })

    const report = buildConformanceReport(result)

    expect(report.taskRef).toBe('issue-99')
    expect(report.model).toBe('claude-opus-5')
    expect(report.usage).toEqual(usage)
  })
})

describe('countVerdicts', () => {
  it('cuenta cada tipo de veredicto, incluidos los que no aparecen (cero)', () => {
    const counts = countVerdicts([
      makeVerdict(1, 'PASS'),
      makeVerdict(2, 'PASS'),
      makeVerdict(3, 'FAIL'),
    ])

    expect(counts).toEqual({ PASS: 2, FAIL: 1, SIN_EVIDENCIA: 0 })
  })
})
