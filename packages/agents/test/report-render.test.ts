import { ValidationError } from '@coord/core'
import { describe, expect, it } from 'vitest'

import { buildConformanceReport } from '../src/verification/report.js'
import {
  DEFAULT_SCREEN_BUDGET,
  renderConformanceReportMarkdown,
  renderConformanceReportPlainText,
  type RenderedConformanceReport,
} from '../src/verification/report-render.js'
import {
  makeVerdict,
  makeVerdicts,
  makeVerificationResult,
  SAMPLE_ARTIFACT,
} from './support/report-fixtures.js'
import type { CriterionVerdict } from '../src/verification/verifier.js'

/**
 * T05 — "cabe en una pantalla" medido (no afirmado) contra `DEFAULT_SCREEN_BUDGET`,
 * el truncado que nunca recorta FAIL/SIN_EVIDENCIA, y que los dos renderizados
 * dicen lo mismo.
 */

function reportWith(verdicts: readonly CriterionVerdict[]) {
  return buildConformanceReport(makeVerificationResult(verdicts))
}

function assertFitsBudget(rendered: RenderedConformanceReport): void {
  expect(rendered.lineCount).toBeLessThanOrEqual(DEFAULT_SCREEN_BUDGET.maxLines)
  expect(rendered.charCount).toBeLessThanOrEqual(DEFAULT_SCREEN_BUDGET.maxChars)
  expect(rendered.fitsOnScreen).toBe(true)
}

describe('el informe cabe en pantalla con pocos criterios (sin truncar)', () => {
  it('3 criterios: los dos renderizados caben enteros, sin resumir nada', () => {
    // Un FAIL de verdad entre los tres, para que el informe no sea trivial.
    const verdicts = makeVerdicts(3, { failCount: 1 })
    const withFail = reportWith(verdicts)

    const markdown = renderConformanceReportMarkdown(withFail)
    const text = renderConformanceReportPlainText(withFail)

    assertFitsBudget(markdown)
    assertFitsBudget(text)
    expect(markdown.summarizedPassCount).toBe(0)
    expect(text.summarizedPassCount).toBe(0)
    // Con tan pocos criterios nunca hace falta resumir: el detalle completo
    // (razonamiento) de cada uno tiene que estar presente.
    for (const verdict of verdicts) {
      expect(markdown.text).toContain(verdict.reasoning)
      expect(text.text).toContain(verdict.reasoning)
    }
  })
})

describe('el informe cabe en pantalla con 40 criterios (truncando)', () => {
  const verdicts = makeVerdicts(40, { failCount: 4, noEvidenceCount: 2 })
  const passCount = verdicts.filter((v) => v.verdict === 'PASS').length
  const nonPass = verdicts.filter((v) => v.verdict !== 'PASS')

  it('el reparto de la fixture es el esperado (control del propio test)', () => {
    expect(verdicts).toHaveLength(40)
    expect(verdicts.filter((v) => v.verdict === 'FAIL')).toHaveLength(4)
    expect(verdicts.filter((v) => v.verdict === 'SIN_EVIDENCIA')).toHaveLength(2)
    expect(passCount).toBe(34)
    // Y ESTAN REPARTIDOS DE VERDAD. Antes el comentario de la fixture decia que
    // los no-PASS quedaban mezclados por todo el rango y era FALSO: con `i % 3`
    // caian los seis dentro de los diez primeros ordinales, asi que el test del
    // truncado nunca ejercitaba un no-PASS al final.
    const posicionesNoPass = verdicts
      .map((v, i) => (v.verdict === 'PASS' ? -1 : i + 1))
      .filter((ordinal) => ordinal > 0)
    expect(posicionesNoPass.at(-1)).toBe(40)
    expect(posicionesNoPass.some((ordinal) => ordinal > 20)).toBe(true)
    expect(posicionesNoPass.some((ordinal) => ordinal <= 20)).toBe(true)
  })

  it.each([
    ['markdown', renderConformanceReportMarkdown],
    ['texto plano', renderConformanceReportPlainText],
  ] as const)(
    '%s: cabe en el presupuesto y resume los PASS, no los FAIL/SIN_EVIDENCIA',
    (_label, render) => {
      const report = reportWith(verdicts)
      const rendered = render(report)

      assertFitsBudget(rendered)
      expect(rendered.summarizedPassCount).toBe(passCount)

      // Ni un FAIL ni un SIN_EVIDENCIA pierde su razonamiento o sus citas.
      for (const verdict of nonPass) {
        expect(rendered.text).toContain(verdict.criterionId)
        expect(rendered.text).toContain(verdict.reasoning)
        expect(rendered.text).toContain(verdict.criterionQuote)
        expect(rendered.text).toContain(verdict.evidenceQuote)
      }

      // Los PASS resumidos NO llevan su razonamiento (por eso caben).
      const summarizedPass = verdicts.filter((v) => v.verdict === 'PASS')
      for (const verdict of summarizedPass) {
        expect(rendered.text).not.toContain(verdict.reasoning)
      }

      // Y el informe DICE cuantos se resumieron: el humano sabe que hay mas
      // detalle disponible en vez de asumir que esos criterios no importan.
      expect(rendered.text).toContain(String(passCount))
    },
  )
})

describe('los dos renderizados dicen lo mismo', () => {
  it('mismo veredicto global, mismas cuentas, mismos criterios con detalle completo', () => {
    const verdicts = makeVerdicts(40, { failCount: 4, noEvidenceCount: 2 })
    const report = reportWith(verdicts)

    const markdown = renderConformanceReportMarkdown(report)
    const text = renderConformanceReportPlainText(report)

    expect(markdown.summarizedPassCount).toBe(text.summarizedPassCount)
    expect(markdown.fitsOnScreen).toBe(text.fitsOnScreen)

    const countsPattern = /PASS: (\d+) · FAIL: (\d+) · SIN_EVIDENCIA: (\d+) · Total: (\d+)/
    const markdownCounts = markdown.text.match(countsPattern)
    const textCounts = text.text.match(countsPattern)
    expect(markdownCounts).not.toBeNull()
    expect(textCounts).not.toBeNull()
    expect(markdownCounts?.slice(1)).toEqual(textCounts?.slice(1))

    expect(markdown.text.includes('NO APTO') || markdown.text.includes('APTO')).toBe(true)
    expect(text.text.includes('NO APTO') || text.text.includes('APTO')).toBe(true)
    const globalVerdictInMarkdown = markdown.text.includes('NO APTO') ? 'NO APTO' : 'APTO'
    const globalVerdictInText = text.text.includes('NO APTO') ? 'NO APTO' : 'APTO'
    expect(globalVerdictInMarkdown).toBe(globalVerdictInText)

    // Mismo conjunto de criterios con detalle completo (los FAIL/SIN_EVIDENCIA):
    // se comprueba por la presencia del razonamiento, que solo aparece en los
    // bloques NO resumidos.
    const nonPass = verdicts.filter((v) => v.verdict !== 'PASS')
    for (const verdict of nonPass) {
      expect(markdown.text.includes(verdict.reasoning)).toBe(text.text.includes(verdict.reasoning))
      expect(markdown.text.includes(verdict.reasoning)).toBe(true)
    }
  })
})

describe('renderConformanceReportMarkdown / renderConformanceReportPlainText: casos borde', () => {
  it('rechaza un informe sin ningun veredicto', () => {
    const report = reportWith([])
    expect(() => renderConformanceReportMarkdown(report)).toThrow()
    expect(() => renderConformanceReportPlainText(report)).toThrow()
  })

  it.each([
    ['markdown', renderConformanceReportMarkdown],
    ['texto plano', renderConformanceReportPlainText],
  ] as const)(
    '%s: con un presupuesto muy estrecho, sigue sin recortar el unico FAIL',
    (_label, render) => {
      const verdicts = makeVerdicts(10, { failCount: 1 })
      const report = reportWith(verdicts)
      const fail = verdicts.find((v) => v.verdict === 'FAIL')
      expect(fail).toBeDefined()

      const rendered = render(report, { maxLines: 5, maxChars: 200 })

      // No cabe (el presupuesto es deliberadamente irreal), pero el FAIL sigue
      // entero: nunca se oculta un FAIL para caber (CLAUDE.md 7). El renderizado
      // de texto plano tiene su propio bucle de bloques y hasta ahora este caso
      // borde solo ejercitaba el de Markdown.
      expect(rendered.fitsOnScreen).toBe(false)
      expect(rendered.compactionLevel).toBe(2)
      expect(rendered.text).toContain(fail?.reasoning ?? '')
      expect(rendered.text).toContain(fail?.criterionQuote ?? '')
      expect(rendered.text).toContain(fail?.evidenceQuote ?? '')
    },
  )
})

// ===========================================================================
describe('el informe deja de caber por exceso de PASS, no solo por exceso de FAIL', () => {
  /**
   * La cabecera de `report-render.ts` justificaba el unico caso de no-caber como
   * "muchos FAIL con razonamientos largos". Medido, era FALSO: con la
   * compactacion de PASS a una linea por criterio, un informe de 73 criterios
   * TODOS en PASS ya no cabia — 81 lineas — y quedaba una via de compresion
   * completamente inocua sin usar (agrupar varios ids PASS por linea).
   *
   * Este test fija el limite MEDIDO de las dos pasadas para que se vea en el
   * diff el dia que cambie.
   */
  it.each([
    ['markdown', renderConformanceReportMarkdown],
    ['texto plano', renderConformanceReportPlainText],
  ] as const)(
    '%s: 200 criterios todos PASS caben agrupando, y el nivel 1 no bastaba',
    (_label, render) => {
      const report = reportWith(makeVerdicts(200))
      const rendered = render(report)

      assertFitsBudget(rendered)
      // Hizo falta la TERCERA pasada: con una linea por PASS serian 200 lineas.
      expect(rendered.compactionLevel).toBe(2)
      expect(rendered.summarizedPassCount).toBe(200)
      // Y no se ha ocultado ni un id: estan los 200, agrupados.
      for (const verdict of report.verdicts) {
        expect(rendered.text).toContain(verdict.criterionId)
      }
    },
  )

  it('agrupar solo entra cuando hace falta: con pocos PASS se usa una linea por criterio', () => {
    // 45 criterios: no cabe con detalle completo, si cabe con una linea por PASS.
    const rendered = renderConformanceReportMarkdown(reportWith(makeVerdicts(45)))
    expect(rendered.fitsOnScreen).toBe(true)
    expect(rendered.compactionLevel).toBe(1)
  })
})

// ===========================================================================
describe('la cabecera dice sobre que codigo y a que coste', () => {
  it.each([
    ['markdown', renderConformanceReportMarkdown],
    ['texto plano', renderConformanceReportPlainText],
  ] as const)('%s: lleva el SHA verificado, su base y el consumo de tokens', (_label, render) => {
    const rendered = render(reportWith(makeVerdicts(3, { failCount: 1 })))

    // Sin el SHA, un "APTO" pegado en un PR no dice a que diff se refiere.
    expect(rendered.text).toContain(SAMPLE_ARTIFACT.headSha)
    expect(rendered.text).toContain(SAMPLE_ARTIFACT.baseSha)
    // `usage` viajaba en el informe y no lo renderizaba nadie: campo muerto.
    expect(rendered.text).toContain('Tokens:')
  })
})

// ===========================================================================
describe('la salida literal (lo que un humano ve de verdad)', () => {
  /**
   * Un informe pequeño, carácter a carácter. Los tests de arriba comprueban
   * PROPIEDADES (cabe, no recorta un FAIL); este fija la FORMA, que es lo unico
   * que impide que las etiquetas, los separadores o el orden se degraden sin que
   * ninguna asercion se entere.
   */
  it('markdown: dos criterios, uno PASS y uno FAIL', () => {
    const verdicts = [
      makeVerdicts(2, { failCount: 1 })[0],
      makeVerdicts(2, { failCount: 1 })[1],
    ].filter((v): v is NonNullable<typeof v> => v !== undefined)
    const rendered = renderConformanceReportMarkdown(reportWith(verdicts))

    expect(rendered.text).toBe(
      [
        '# Informe de conformidad — issue-25',
        '',
        '**Veredicto global: NO APTO**',
        '',
        `Commit verificado: \`${SAMPLE_ARTIFACT.headSha}\` (base \`${SAMPLE_ARTIFACT.baseSha}\`)`,
        '',
        'Modelo: `claude-opus-5` · PASS: 1 · FAIL: 1 · SIN_EVIDENCIA: 0 · Total: 2 · Tokens: 0 entrada (0 de cache) · 0 salida',
        '',
        `### 1. PASS — ${verdicts[0]?.criterionId ?? ''}`,
        `**Criterio:** "${verdicts[0]?.criterionQuote ?? ''}"`,
        `**Evidencia** (diff): "${verdicts[0]?.evidenceQuote ?? ''}"`,
        `**Razonamiento:** ${verdicts[0]?.reasoning ?? ''}`,
        '',
        `### 2. FAIL — ${verdicts[1]?.criterionId ?? ''}`,
        `**Criterio:** "${verdicts[1]?.criterionQuote ?? ''}"`,
        `**Evidencia** (diff): "${verdicts[1]?.evidenceQuote ?? ''}"`,
        `**Razonamiento:** ${verdicts[1]?.reasoning ?? ''}`,
      ].join('\n'),
    )
    expect(rendered.compactionLevel).toBe(0)
    expect(rendered.summarizedPassCount).toBe(0)
  })

  it('texto plano: mismo informe, con subrayado y sin marcas de Markdown', () => {
    const verdicts = makeVerdicts(2, { failCount: 1 })
    const rendered = renderConformanceReportPlainText(reportWith(verdicts))

    expect(rendered.text).toBe(
      [
        'INFORME DE CONFORMIDAD — issue-25',
        '='.repeat('INFORME DE CONFORMIDAD — issue-25'.length),
        '',
        'VEREDICTO GLOBAL: NO APTO',
        '',
        `Commit verificado: ${SAMPLE_ARTIFACT.headSha} (base ${SAMPLE_ARTIFACT.baseSha})`,
        '',
        'Modelo: claude-opus-5 | PASS: 1 · FAIL: 1 · SIN_EVIDENCIA: 0 · Total: 2 | Tokens: 0 entrada (0 de cache) · 0 salida',
        '',
        `1. PASS — ${verdicts[0]?.criterionId ?? ''}`,
        `   Criterio: "${verdicts[0]?.criterionQuote ?? ''}"`,
        `   Evidencia (diff): "${verdicts[0]?.evidenceQuote ?? ''}"`,
        `   Razonamiento: ${verdicts[0]?.reasoning ?? ''}`,
        '',
        `2. FAIL — ${verdicts[1]?.criterionId ?? ''}`,
        `   Criterio: "${verdicts[1]?.criterionQuote ?? ''}"`,
        `   Evidencia (diff): "${verdicts[1]?.evidenceQuote ?? ''}"`,
        `   Razonamiento: ${verdicts[1]?.reasoning ?? ''}`,
      ].join('\n'),
    )
  })

  it('markdown compactado: los PASS agrupados llevan su etiqueta y sus ids', () => {
    const rendered = renderConformanceReportMarkdown(reportWith(makeVerdicts(200)))

    // La forma exacta de una linea agrupada: bullet, etiqueta y los ids
    // separados por coma. Ocho por linea.
    expect(rendered.text).toContain(
      '- PASS · criterion-1, criterion-2, criterion-3, criterion-4, criterion-5, criterion-6, criterion-7, criterion-8',
    )
    expect(rendered.text).toContain('criterio(s) PASS')
    expect(rendered.text).toContain('Ningun FAIL ni SIN_EVIDENCIA se ha recortado')
  })
})

// ===========================================================================
describe('la frontera del presupuesto: cabe es "<=", no "<"', () => {
  /**
   * `fitsBudget` compara con `<=`. Un informe que mide EXACTAMENTE el
   * presupuesto cabe; uno que se pasa por una sola linea o un solo caracter,
   * no. La diferencia entre `<` y `<=` no la nota ningun test que use
   * presupuestos holgados o absurdamente estrechos —y eran los dos unicos
   * que habia—, asi que se comprueba en el borde exacto: se mide el
   * renderizado sin comprimir y se le da ese mismo tamaño como presupuesto.
   */
  it.each([
    ['markdown', renderConformanceReportMarkdown],
    ['texto plano', renderConformanceReportPlainText],
  ] as const)(
    '%s: justo en el limite cabe; una linea o un caracter menos, no',
    (_label, render) => {
      const report = reportWith(makeVerdicts(2, { failCount: 1 }))
      const sinComprimir = render(report, { maxLines: 1_000, maxChars: 100_000 })
      expect(sinComprimir.compactionLevel).toBe(0)
      const { lineCount, charCount } = sinComprimir

      // Presupuesto EXACTO: cabe sin comprimir nada.
      const justo = render(report, { maxLines: lineCount, maxChars: charCount })
      expect(justo.fitsOnScreen).toBe(true)
      expect(justo.compactionLevel).toBe(0)
      expect(justo.text).toBe(sinComprimir.text)

      // Una linea menos: la pasada 0 ya no cabe y hay que resumir los PASS.
      const unaLineaMenos = render(report, { maxLines: lineCount - 1, maxChars: charCount })
      expect(unaLineaMenos.compactionLevel).toBe(1)
      expect(unaLineaMenos.summarizedPassCount).toBe(1)

      // Un caracter menos: igual. El limite de caracteres no es decorativo.
      const unCaracterMenos = render(report, { maxLines: lineCount, maxChars: charCount - 1 })
      expect(unCaracterMenos.compactionLevel).toBe(1)
      expect(unCaracterMenos.summarizedPassCount).toBe(1)
    },
  )
})

// ===========================================================================
describe('las tres etiquetas de veredicto, y el total que las suma', () => {
  /**
   * SIN_EVIDENCIA es el veredicto por el que existe el epic —el permiso
   * explicito para no dar un PASS optimista— y hasta ahora ningun test
   * comprobaba que su etiqueta llegara escrita al informe. Tampoco habia
   * ninguno con las tres cuentas distintas de cero, asi que la suma del total
   * podia ser cualquier operacion.
   */
  it('markdown: PASS, FAIL y SIN_EVIDENCIA, cada uno con su etiqueta y sumados', () => {
    const verdicts = [
      makeVerdict(1, 'PASS'),
      makeVerdict(2, 'FAIL'),
      makeVerdict(3, 'SIN_EVIDENCIA'),
    ]
    const rendered = renderConformanceReportMarkdown(reportWith(verdicts))

    expect(rendered.text).toContain('PASS: 1 · FAIL: 1 · SIN_EVIDENCIA: 1 · Total: 3')
    expect(rendered.text).toContain('### 1. PASS — criterion-1')
    expect(rendered.text).toContain('### 2. FAIL — criterion-2')
    expect(rendered.text).toContain('### 3. SIN_EVIDENCIA — criterion-3')
    // Un SIN_EVIDENCIA nunca se resume: conserva su razonamiento entero.
    expect(rendered.text).toContain(verdicts[2]?.reasoning ?? '')
    expect(rendered.compactionLevel).toBe(0)
  })
})

// ===========================================================================
describe('comprimir no reordena: cada racha de PASS se queda en su sitio', () => {
  /**
   * El caso que ningun test tocaba: PASS resumidos ANTES de un bloque con
   * detalle, y dos rachas separadas. Es donde vive la unica logica no trivial
   * de `renderBlocks` (vaciar la racha pendiente justo antes de emitir un
   * bloque detallado), y sin este test daba igual que las lineas PASS
   * acabaran todas juntas al final del informe: ninguna asercion miraba el
   * ORDEN, solo la presencia.
   *
   * Presupuesto elegido a proposito para que la pasada 0 no quepa y la 1 si:
   * es la unica forma de ejercitar el intercalado.
   */
  const verdicts = [1, 2, 3, 4, 5, 6].map((n) =>
    makeVerdict(n, n === 3 || n === 6 ? 'FAIL' : 'PASS'),
  )
  const criterio = (n: number): CriterionVerdict => {
    const verdict = verdicts[n - 1]
    if (verdict === undefined) throw new Error(`la fixture no tiene criterio ${String(n)}`)
    return verdict
  }
  const BUDGET = { maxLines: 30, maxChars: 100_000 }
  const NOTA =
    '4 criterio(s) PASS se resumieron a una linea para que el informe quepa en pantalla. ' +
    'Estan TODOS por su id; lo que se quita es el razonamiento y las citas de los PASS. ' +
    'Ningun FAIL ni SIN_EVIDENCIA se ha recortado.'

  it('markdown: PASS 1-2, FAIL 3, PASS 4-5, FAIL 6, en ese orden', () => {
    const rendered = renderConformanceReportMarkdown(reportWith(verdicts), BUDGET)

    expect(rendered.compactionLevel).toBe(1)
    expect(rendered.text).toBe(
      [
        '# Informe de conformidad — issue-25',
        '',
        '**Veredicto global: NO APTO**',
        '',
        `Commit verificado: \`${SAMPLE_ARTIFACT.headSha}\` (base \`${SAMPLE_ARTIFACT.baseSha}\`)`,
        '',
        'Modelo: `claude-opus-5` · PASS: 4 · FAIL: 2 · SIN_EVIDENCIA: 0 · Total: 6 · Tokens: 0 entrada (0 de cache) · 0 salida',
        '',
        `_${NOTA}_`,
        '',
        '- PASS · criterion-1',
        '- PASS · criterion-2',
        '',
        '### 3. FAIL — criterion-3',
        `**Criterio:** "${criterio(3).criterionQuote}"`,
        `**Evidencia** (diff): "${criterio(3).evidenceQuote}"`,
        `**Razonamiento:** ${criterio(3).reasoning}`,
        '',
        '- PASS · criterion-4',
        '- PASS · criterion-5',
        '',
        '### 6. FAIL — criterion-6',
        `**Criterio:** "${criterio(6).criterionQuote}"`,
        `**Evidencia** (diff): "${criterio(6).evidenceQuote}"`,
        `**Razonamiento:** ${criterio(6).reasoning}`,
      ].join('\n'),
    )
  })

  it('texto plano: mismo orden, misma nota sin los guiones bajos de Markdown', () => {
    const rendered = renderConformanceReportPlainText(reportWith(verdicts), BUDGET)

    expect(rendered.compactionLevel).toBe(1)
    expect(rendered.text).toBe(
      [
        'INFORME DE CONFORMIDAD — issue-25',
        '='.repeat('INFORME DE CONFORMIDAD — issue-25'.length),
        '',
        'VEREDICTO GLOBAL: NO APTO',
        '',
        `Commit verificado: ${SAMPLE_ARTIFACT.headSha} (base ${SAMPLE_ARTIFACT.baseSha})`,
        '',
        'Modelo: claude-opus-5 | PASS: 4 · FAIL: 2 · SIN_EVIDENCIA: 0 · Total: 6 | Tokens: 0 entrada (0 de cache) · 0 salida',
        '',
        NOTA,
        '',
        '- PASS · criterion-1',
        '- PASS · criterion-2',
        '',
        '3. FAIL — criterion-3',
        `   Criterio: "${criterio(3).criterionQuote}"`,
        `   Evidencia (diff): "${criterio(3).evidenceQuote}"`,
        `   Razonamiento: ${criterio(3).reasoning}`,
        '',
        '- PASS · criterion-4',
        '- PASS · criterion-5',
        '',
        '6. FAIL — criterion-6',
        `   Criterio: "${criterio(6).criterionQuote}"`,
        `   Evidencia (diff): "${criterio(6).evidenceQuote}"`,
        `   Razonamiento: ${criterio(6).reasoning}`,
      ].join('\n'),
    )
  })
})

// ===========================================================================
describe('agrupar PASS: cuantas lineas exactamente, y ninguna vacia', () => {
  /**
   * `- PASS · ` con la lista vacia detras es una linea que no dice nada y que
   * nadie habria notado: los tests de agrupado solo comprobaban que los ids
   * ESTUVIERAN, no cuantas lineas salian. Con 200 ids de 8 en 8 son 25 lineas
   * exactas; una mas significa que el bucle se pasa del final del array.
   */
  it('200 PASS salen en exactamente 25 lineas de 8 ids, y no hay ni una linea mas', () => {
    const rendered = renderConformanceReportMarkdown(reportWith(makeVerdicts(200)))

    // El informe ENTERO, linea a linea. Filtrar las que empiezan por "- PASS ·"
    // y contarlas no basta: una linea de sobra que no case con ese prefijo se
    // cuela sin que nadie la vea, y una racha vacia al final del bucle sale
    // como "- PASS ·" a secas porque `trimEnd` se come su ultimo espacio.
    const grupos = Array.from(
      { length: Math.ceil(200 / 8) },
      (_unused, grupo) =>
        `- PASS · ${Array.from(
          { length: 8 },
          (_id, posicion) => `criterion-${String(grupo * 8 + posicion + 1)}`,
        ).join(', ')}`,
    )
    expect(rendered.compactionLevel).toBe(2)
    expect(rendered.text).toBe(
      [
        '# Informe de conformidad — issue-25',
        '',
        '**Veredicto global: APTO**',
        '',
        `Commit verificado: \`${SAMPLE_ARTIFACT.headSha}\` (base \`${SAMPLE_ARTIFACT.baseSha}\`)`,
        '',
        'Modelo: `claude-opus-5` · PASS: 200 · FAIL: 0 · SIN_EVIDENCIA: 0 · Total: 200 · Tokens: 0 entrada (0 de cache) · 0 salida',
        '',
        '_200 criterio(s) PASS se resumieron y agrupados varios por linea para que el informe quepa en pantalla. Estan TODOS por su id; lo que se quita es el razonamiento y las citas de los PASS. Ningun FAIL ni SIN_EVIDENCIA se ha recortado._',
        '',
        ...grupos,
      ].join('\n'),
    )
  })

  it('la nota dice que se AGRUPARON, no solo que se resumieron', () => {
    // El texto de la nota cambia entre la pasada 1 y la 2, y esa es la unica
    // señal que tiene el humano de cuanto se ha comprimido lo que esta leyendo.
    const nivel2 = renderConformanceReportMarkdown(reportWith(makeVerdicts(200)))
    expect(nivel2.text).toContain(
      '_200 criterio(s) PASS se resumieron y agrupados varios por linea para que el informe quepa en pantalla.',
    )
    expect(nivel2.text).not.toContain('se resumieron a una linea')
  })
})

// ===========================================================================
describe('un informe sin veredictos se rechaza diciendo por que', () => {
  it.each([
    ['markdown', renderConformanceReportMarkdown],
    ['texto plano', renderConformanceReportPlainText],
  ] as const)('%s: ValidationError con el motivo, no un error mudo', (_label, render) => {
    const report = reportWith([])
    // El mensaje forma parte del contrato: quien lo lea tiene que entender que
    // el problema es que no hay nada que decidir, no un fallo del renderizado.
    expect(() => render(report)).toThrow(ValidationError)
    expect(() => render(report)).toThrow(
      'El informe de issue-25 no trae ni un veredicto. Un informe vacio no es un informe: ' +
        'no hay nada con que decidir.',
    )
  })
})
