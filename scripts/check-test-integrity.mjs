#!/usr/bin/env node
// scripts/check-test-integrity.mjs
//
// Deteccion de manipulacion de tests sobre el diff de un PR (Epic 05 / T03,
// Issue #23). CLAUDE.md epic-05: "se diseña asumiendo que el agente hara
// trampa, porque esta documentado que lo hace: hardcodea valores esperados,
// debilita aserciones, borra ficheros de test, y en tareas imposibles inventa
// formas de que el test pase sin resolver nada."
//
// Que caza, y por que cada uno con SU heuristica propia (no un regex unico):
//   1. Ficheros de test borrados.
//   2. Aserciones debilitadas POR CANTIDAD: el total de
//      expect()/assert()/toThrow()/rejects en los ficheros de test BAJA entre
//      la base y la cabeza, o baja el subtotal de los ficheros PREEXISTENTES
//      aunque el total lo compense un fichero nuevo.
//   3. Aserciones debilitadas POR MATCHER: la misma asercion pasa de un matcher
//      concreto (toEqual/toBe/toThrow...) a uno permisivo (toBeDefined,
//      toBeTruthy...). El conteo no se mueve y el test ya no comprueba nada.
//   4. Aserciones vacuas anadidas: expect(true).toBe(true) y familia.
//   5. skip/only/todo anadidos sin un comentario que lo justifique en la
//      propia linea del diff.
//   6. Umbrales que bajan: thresholds.{high,low,break} en stryker.config.json,
//      modulos que DESAPARECEN de su lista `mutate`, y comparaciones numericas
//      (toBeGreaterThan(N) y familia) que bajan entre la linea borrada y la
//      linea anadida del mismo hunk.
//   7. El propio cableado del gate: que `ci-ok` no pierda ningun job de su
//      lista `needs` y que el CI siga invocando este script.
//   8. El manifiesto de tests generados (T02) borrado.
//
// ===========================================================================
// POR QUE "TOTAL" Y NO "POR FICHERO" PARA LAS ASERCIONES (punto 2)
// ===========================================================================
// Un refactor legitimo MUEVE tests entre ficheros (parte uno en dos, junta
// dos en uno, renombra). Contar por fichero confundiria "movido" con
// "borrado": el fichero origen pierde aserciones aunque el PR no debilite
// nada. Sumar el total del PATHSPEC de test ANTES vs DESPUES no tiene ese
// problema: si las aserciones solo se movieron, el total no baja.
//
// PERO EL TOTAL SOLO NO BASTA, y esto estuvo roto: vaciar un fichero real de
// sus 68 aserciones y anadir un fichero NUEVO con 70 `expect(1).toBeDefined()`
// dejaba el total igual y el gate en verde. Por eso se cruza con el subtotal de
// los ficheros PREEXISTENTES (los que ya tenian aserciones en la base): si ese
// subtotal baja, se bloquea aunque el total se sostenga. Falso positivo
// conocido y asumido: partir un fichero de test en uno existente y otro NUEVO
// baja el subtotal preexistente; para eso esta el trailer de override, que deja
// el motivo firmado en el historial.
//
// ===========================================================================
// LA VIA DE ESCAPE, Y POR QUE ES UN TRAILER DE COMMIT
// ===========================================================================
// "Un gate sin escape del que la gente no puede salir se acaba desactivando
// entero" (Issue #23). La escapatoria es un trailer en el CUERPO de un commit
// del rango que se esta verificando:
//
//   Test-Integrity-Override: <motivo>
//
// Se eligio un trailer de commit y no una etiqueta de PR porque: (a) ya existe
// la convencion de mensajes obligatorios ("Issue #N: ...", hook
// commit-msg) sobre la que este trailer es una linea mas; (b) queda en el
// historial de git para siempre, con autor y fecha, sin depender de llamar a
// la API de GitHub ni de un token con permisos sobre el repo; (c) funciona
// igual en local que en CI. El precio es que CUALQUIERA con permiso de push
// puede escribirlo: es una escapatoria auditable, no una que exija
// aprobacion — igual que el resto de la Capa 2 de docs/quality-gates.md, que
// bloquea pero no decide (CLAUDE.md 2.1, "el humano decide": aqui el humano
// que decide es quien firma el commit con su motivo, a la vista de todos).
// Si se necesita una segunda cerradura (aprobacion de otra persona), eso lo
// da la review del PR, no este script.
//
// El override es TODO o NADA: no hay forma de decir "salta solo el hallazgo
// del fichero X". Es deliberado (ladder de CLAUDE.md 2.4, "el minimo que
// funciona"): un override selectivo por hallazgo es mucho mas codigo para un
// caso que en la practica es raro, y cuando aparece, el motivo del trailer
// ya dice a que se aplica.
//
// ===========================================================================
// LO QUE ESTE GATE NO ES
// ===========================================================================
// Ver docs/quality-gates.md: los detectores de "valor hardcodeado" y de
// umbrales numericos son heuristicas ACOTADAS sobre texto, no analisis
// semantico. Cazan el caso obvio (linea calcada salvo el numero) y avisan;
// no persiguen falsos negativos mas alla de eso. La deteccion real de "se
// hardcodeo el valor esperado" la dan el mutation testing y el Verifier
// (T04) — este script lo declara, no lo pretende.

import { execFileSync } from 'node:child_process'
import process from 'node:process'

// El pathspec ya no es solo `**/*.test.ts`. Un `.spec.ts`, un `.test.tsx` o un
// helper con aserciones bajo `test/` quedaban FUERA del gate sin que nadie se
// enterase: la convencion de nombres sostenia el gate entero y no estaba escrita
// en ningun sitio. Ahora entran las dos formas y el arbol `test/` completo.
const TEST_FILE_GLOBS = [
  ':(glob)**/*.{test,spec}.{ts,tsx,mts}',
  ':(glob)**/test/**/*.ts',
  // packages/core/src/tenant.test.ts vive en src/, asi que el patron por
  // directorio no lo cubre; lo cubre el primero.
]
const STRYKER_CONFIG_PATH = 'stryker.config.json'
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml'
const GENERATED_TESTS_MANIFEST_PATH = 'verification/generated-tests.manifest.json'
const OVERRIDE_TRAILER_RE = /^Test-Integrity-Override:[ \t]*(\S.*)$/m

/** Los ficheros sobre los que disparan los detectores 3-5 (los que leen el diff). */
const TEST_FILE_RE = /(\.(test|spec)\.(ts|tsx|mts)$)|(^|\/)test\/.+\.ts$/
function isTestFile(path) {
  return TEST_FILE_RE.test(path)
}

// expect(...), assert(...), assert.algo(...), .toThrow(...), .rejects — el
// vocabulario de asercion de vitest/chai/node:assert que se usa en este repo.
const ASSERTION_RE = /\bexpect\(|\bassert\(|\bassert\.\w+\(|\.toThrow\(|\.rejects\b/g

const VACUOUS_RES = [
  // expect(<literal>).toBe/toEqual/toStrictEqual(<mismo literal>) — la
  // tautologia clasica. El backreference exige el MISMO literal a ambos
  // lados: expect(1).toBe(2) no es vacuo, es (como minimo) un test raro,
  // pero no una asercion que no puede fallar nunca.
  /\bexpect\(\s*(true|false|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\(\s*\1\s*\)/,
  /\bexpect\(\s*true\s*\)\s*\.\s*toBeTruthy\(\s*\)/,
  /\bexpect\(\s*false\s*\)\s*\.\s*toBeFalsy\(\s*\)/,
  // assert(true), assert.ok(true) y assert.equal/strictEqual(<literal>, <mismo literal>)
  /\bassert(?:\.ok)?\(\s*true\s*\)/,
  /\bassert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\(\s*(true|false|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")\s*,\s*\1\s*\)/,
]

const SKIP_RE = /\b(?:it|test|describe)\.(skip|only|todo)\(/

// ===========================================================================
// MATCHERS: CONCRETOS vs PERMISIVOS (detector 3)
// ===========================================================================
// El criterio de aceptacion dice "borra o DEBILITA aserciones", y debilitar sin
// borrar pasaba limpio: cambiar `expect(x).toEqual([1, 2])` por
// `expect(x).toBeDefined()` deja el conteo EXACTAMENTE igual (`expect(` sigue
// siendo una ocurrencia), el fichero sigue ahi y los tests siguen verdes. Es la
// trampa mas comoda que hay.
//
// Un matcher CONCRETO ata la asercion a un valor o a un comportamiento: si el
// codigo cambia, falla. Uno PERMISIVO solo dice "existe algo": pasa con casi
// cualquier valor. Pasar del primero al segundo, sobre el MISMO sujeto y en el
// MISMO hunk, es debilitar.
const SPECIFIC_MATCHERS = new Set([
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toThrow',
  'toThrowError',
  'toMatch',
  'toMatchObject',
  'toContain',
  'toContainEqual',
  'toHaveLength',
  'toHaveProperty',
  'toHaveBeenCalledWith',
  'toHaveBeenCalledTimes',
])
const PERMISSIVE_MATCHERS = new Set([
  'toBeDefined',
  'toBeTruthy',
  'toBeFalsy',
  'toBeUndefined',
  'toBeInstanceOf',
  'toBeTypeOf',
])
// Solo son permisivos NEGADOS: `expect(x).toBeNull()` es concreto,
// `expect(x).not.toBeNull()` no dice practicamente nada.
const NEGATED_PERMISSIVE_MATCHERS = new Set(['toBeNull', 'toBeUndefined', 'toBeNaN'])

const MATCHER_CALL_RE = /\.\s*(not\s*\.\s*)?([A-Za-z][A-Za-z0-9]*)\s*\(/g

/**
 * Parte una linea de asercion en SUJETO (lo que se compara) y MATCHER.
 *
 * Se queda con la ULTIMA llamada a un matcher conocido de la linea: los
 * matchers encadenan al final, y asi `expect(rows.map((r) => r.id)).toEqual(...)`
 * no confunde `.map(` con un matcher. Devuelve `null` si la linea no lleva
 * ninguno de los matchers que este detector conoce.
 *
 * El sujeto se normaliza (espacios colapsados, `.not`/`.resolves`/`.rejects`
 * finales fuera) para que un cambio de indentacion o de negacion no impida
 * emparejar la linea borrada con la anadida.
 */
function splitAssertion(line) {
  MATCHER_CALL_RE.lastIndex = 0
  let last = null
  let match
  while ((match = MATCHER_CALL_RE.exec(line)) !== null) {
    const name = match[2]
    const negated = Boolean(match[1])
    if (
      SPECIFIC_MATCHERS.has(name) ||
      PERMISSIVE_MATCHERS.has(name) ||
      NEGATED_PERMISSIVE_MATCHERS.has(name)
    ) {
      last = { index: match.index, name, negated }
    }
  }
  if (last === null) return null
  const subject = line
    .slice(0, last.index)
    .replace(/\.\s*(resolves|rejects)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const permissive =
    PERMISSIVE_MATCHERS.has(last.name) ||
    (last.negated && NEGATED_PERMISSIVE_MATCHERS.has(last.name))
  const specific = !permissive && SPECIFIC_MATCHERS.has(last.name)
  return { subject, matcher: last.negated ? `not.${last.name}` : last.name, permissive, specific }
}

// Matchers de umbral numerico: "un numero que baja" solo importa en estos.
const THRESHOLD_MATCHERS = [
  'toBeGreaterThanOrEqual',
  'toBeGreaterThan',
  'toBeLessThanOrEqual',
  'toBeLessThan',
  'toBeCloseTo',
]
const THRESHOLD_LINE_RE = new RegExp(`\\.(?:${THRESHOLD_MATCHERS.join('|')})\\(`)
const NUMBER_RE = /-?\d+(?:\.\d+)?/

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 128,
  })
}

/** Como `git`, pero null si el ref/objeto no existe (p.ej. fichero nuevo). */
function gitOrNull(args) {
  try {
    return git(args)
  } catch {
    return null
  }
}

function resolveRefs() {
  const base =
    process.env.TEST_INTEGRITY_BASE_REF ??
    (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main')
  const head = process.env.TEST_INTEGRITY_HEAD_REF ?? 'HEAD'
  return { base, head }
}

function countAssertions(text) {
  if (text === null) return 0
  const matches = text.match(ASSERTION_RE)
  return matches ? matches.length : 0
}

/**
 * `git diff --name-status -M` sobre el pathspec dado, en forma tipada.
 * -M activa deteccion de renombrados: sin ella, mover un fichero de test
 * entero aparece como D + A y dispara el gate de "fichero de test borrado"
 * por un simple `git mv`.
 */
function nameStatus(range, pathspecs) {
  const out = gitOrNull(['diff', '--name-status', '-M', range, '--', ...pathspecs])
  if (!out) return []
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const fields = line.split('\t')
      const status = fields[0]
      if (status.startsWith('R') || status.startsWith('C')) {
        return { status: status[0], oldPath: fields[1], newPath: fields[2] }
      }
      if (status === 'D') return { status, oldPath: fields[1], newPath: null }
      if (status === 'A') return { status, oldPath: null, newPath: fields[1] }
      return { status, oldPath: fields[1], newPath: fields[1] }
    })
}

/** Parser de unified diff minimo: solo lo que necesitan los detectores 3-5. */
function parseUnifiedDiffByFile(diffText) {
  const files = []
  let current = null
  let hunk = null
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { path: null, hunks: [] }
      files.push(current)
      hunk = null
      continue
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim()
      if (p !== '/dev/null') current.path = p.replace(/^b\//, '')
      continue
    }
    if (line.startsWith('@@')) {
      hunk = { removed: [], added: [] }
      current.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) hunk.added.push(line.slice(1))
    else if (line.startsWith('-')) hunk.removed.push(line.slice(1))
  }
  return files.filter((f) => f.path)
}

function findOverride(range) {
  // %x1f/%x1e como separadores: no van a aparecer en un mensaje de commit de
  // verdad, a diferencia de un salto de linea o un delimitador de texto.
  const log = gitOrNull(['log', '--format=%H%x1f%B%x1e', range])
  if (!log) return null
  for (const entry of log.split('\x1e')) {
    if (!entry.trim()) continue
    const sep = entry.indexOf('\x1f')
    if (sep === -1) continue
    const sha = entry.slice(0, sep)
    const body = entry.slice(sep + 1)
    const match = body.match(OVERRIDE_TRAILER_RE)
    if (match) return { sha: sha.slice(0, 12), reason: match[1].trim() }
  }
  return null
}

function checkDeletedTestFiles(entries, findings) {
  for (const e of entries) {
    if (e.status === 'D') {
      findings.push({
        blocking: true,
        summary: `fichero de test borrado: ${e.oldPath}`,
      })
    }
  }
}

function checkWeakenedAssertions(entries, mergeBase, head, findings) {
  const perFile = []
  for (const e of entries) {
    const oldText = e.oldPath ? gitOrNull(['show', `${mergeBase}:${e.oldPath}`]) : null
    const newText = e.newPath ? gitOrNull(['show', `${head}:${e.newPath}`]) : null
    const oldCount = countAssertions(oldText)
    const newCount = countAssertions(newText)
    perFile.push({ path: e.newPath ?? e.oldPath, oldCount, newCount })
  }
  const totalOld = perFile.reduce((s, f) => s + f.oldCount, 0)
  const totalNew = perFile.reduce((s, f) => s + f.newCount, 0)
  const dropped = perFile
    .filter((f) => f.newCount < f.oldCount)
    .map((f) => `${f.path}: ${f.oldCount} -> ${f.newCount}`)
    .join('; ')

  if (totalNew < totalOld) {
    findings.push({
      blocking: true,
      summary: `aserciones totales bajan de ${totalOld} a ${totalNew} en los ficheros de test tocados (${dropped})`,
    })
    return
  }

  // El total puede sostenerse con RELLENO: vaciar un fichero real y anadir uno
  // nuevo con la misma cantidad de aserciones triviales. Por eso se cruza con el
  // subtotal de los ficheros PREEXISTENTES (los que ya tenian aserciones en la
  // base). Si ese subtotal baja, algo se debilito en codigo que ya existia,
  // compense quien compense. Ver la cabecera de este fichero para el falso
  // positivo asumido (partir un fichero hacia otro NUEVO) y su via de escape.
  const preexisting = perFile.filter((f) => f.oldCount > 0)
  const preexistingOld = preexisting.reduce((s, f) => s + f.oldCount, 0)
  const preexistingNew = preexisting.reduce((s, f) => s + f.newCount, 0)
  if (preexistingNew < preexistingOld) {
    findings.push({
      blocking: true,
      summary:
        `el total de aserciones se sostiene (${totalOld} -> ${totalNew}) pero el de los ficheros ` +
        `PREEXISTENTES baja de ${preexistingOld} a ${preexistingNew} (${dropped}): las que faltan ` +
        'las esta compensando codigo nuevo, no un movimiento entre ficheros que ya existian',
    })
  }
}

/**
 * DETECTOR 3 — la misma asercion cambia a un matcher permisivo.
 *
 * Empareja por SUJETO dentro del mismo hunk, con el mismo patron de "misma
 * forma" que ya usa `checkThresholdsInTests`: si una linea borrada y una anadida
 * comparan lo mismo y el matcher pasa de concreto a permisivo, es debilitar.
 *
 * ACOTADO A PROPOSITO: solo dispara cuando el sujeto es IDENTICO. Reescribir la
 * asercion entera (otro sujeto) no lo caza, y eso es correcto — ahi ya no se
 * puede decir a maquina si es un refactor o una trampa, y un gate que adivina se
 * acaba desactivando entero.
 */
function checkWeakenedMatchers(filesInDiff, findings) {
  for (const f of filesInDiff) {
    if (!isTestFile(f.path)) continue
    for (const hunk of f.hunks) {
      const removedBySubject = new Map()
      for (const line of hunk.removed) {
        const parsed = splitAssertion(line)
        if (parsed === null || !parsed.specific) continue
        const queue = removedBySubject.get(parsed.subject) ?? []
        queue.push({ line, matcher: parsed.matcher })
        removedBySubject.set(parsed.subject, queue)
      }
      for (const line of hunk.added) {
        const parsed = splitAssertion(line)
        if (parsed === null || !parsed.permissive) continue
        const queue = removedBySubject.get(parsed.subject)
        if (!queue || queue.length === 0) continue
        const removed = queue.shift()
        findings.push({
          blocking: true,
          summary:
            `asercion debilitada en ${f.path}: el matcher pasa de \`${removed.matcher}\` a ` +
            `\`${parsed.matcher}\` sobre el mismo sujeto ("${removed.line.trim()}" -> ` +
            `"${line.trim()}"). El conteo de aserciones no se mueve y la asercion ya no ata nada`,
        })
      }
    }
  }
}

function checkVacuousAssertions(filesInDiff, findings) {
  for (const f of filesInDiff) {
    if (!isTestFile(f.path)) continue
    for (const hunk of f.hunks) {
      for (const line of hunk.added) {
        if (VACUOUS_RES.some((re) => re.test(line))) {
          findings.push({
            blocking: true,
            summary: `asercion vacua anadida en ${f.path}: ${line.trim()}`,
          })
        }
      }
    }
  }
}

function checkUnjustifiedSkips(filesInDiff, findings) {
  for (const f of filesInDiff) {
    if (!isTestFile(f.path)) continue
    for (const hunk of f.hunks) {
      for (const line of hunk.added) {
        const match = line.match(SKIP_RE)
        if (!match) continue
        // Justificacion "en el propio diff": un comentario en la misma linea
        // anadida. Acotado a proposito (CLAUDE.md 2.4): no intenta juzgar si
        // el comentario es un buen motivo, solo que exista uno, auditable a
        // simple vista en el propio PR.
        const hasInlineComment = line.includes('//')
        if (hasInlineComment) {
          // NO BLOQUEA, pero SE IMPRIME. Antes no dejaba rastro ninguno en la
          // salida del gate, con lo que existian dos vias de escape con
          // auditabilidad muy distinta: la del trailer, firmada en el historial
          // y a la vista en el log del job, y esta, invisible. Ahora las dos se
          // ven; solo una bloquea.
          findings.push({
            blocking: false,
            summary: `.${match[1]}( anadido CON justificacion en linea en ${f.path}: ${line.trim()}`,
          })
          continue
        }
        findings.push({
          blocking: true,
          summary: `.${match[1]}( anadido sin comentario que lo justifique en ${f.path}: ${line.trim()}`,
        })
      }
    }
  }
}

function checkThresholdsInTests(filesInDiff, findings) {
  for (const f of filesInDiff) {
    if (!isTestFile(f.path)) continue
    for (const hunk of f.hunks) {
      // Emparejar por "forma" (la linea sin el numero): si una linea borrada
      // y una anadida del MISMO hunk coinciden salvo el numero, es la misma
      // comparacion con el umbral movido.
      const removedByShape = new Map()
      for (const line of hunk.removed) {
        if (!THRESHOLD_LINE_RE.test(line)) continue
        const numMatch = line.match(NUMBER_RE)
        if (!numMatch) continue
        const shape = line.replace(NUMBER_RE, '\0')
        const queue = removedByShape.get(shape) ?? []
        queue.push({ line, value: Number(numMatch[0]) })
        removedByShape.set(shape, queue)
      }
      for (const line of hunk.added) {
        if (!THRESHOLD_LINE_RE.test(line)) continue
        const numMatch = line.match(NUMBER_RE)
        if (!numMatch) continue
        const shape = line.replace(NUMBER_RE, '\0')
        const queue = removedByShape.get(shape)
        if (!queue || queue.length === 0) continue
        const removed = queue.shift()
        const addedValue = Number(numMatch[0])
        if (addedValue < removed.value) {
          findings.push({
            blocking: true,
            summary: `umbral bajado en ${f.path}: "${removed.line.trim()}" -> "${line.trim()}"`,
          })
        }
      }
    }
  }
}

function checkStrykerThresholds(entries, mergeBase, head, findings) {
  const touched = entries.find(
    (e) => e.newPath === STRYKER_CONFIG_PATH || e.oldPath === STRYKER_CONFIG_PATH,
  )
  if (!touched) return
  const oldText = touched.oldPath ? gitOrNull(['show', `${mergeBase}:${touched.oldPath}`]) : null
  const newText = touched.newPath ? gitOrNull(['show', `${head}:${touched.newPath}`]) : null
  if (!oldText || !newText) return // fichero nuevo o borrado: ya lo cubren otros checks/gates
  let oldConfig
  let newConfig
  try {
    oldConfig = JSON.parse(oldText)
    newConfig = JSON.parse(newText)
  } catch (err) {
    // Un JSON que no parsea no es "no hay hallazgo": es un problema real que
    // hay que ver, no tragar (CLAUDE.md: nunca catch silencioso).
    findings.push({
      blocking: true,
      summary: `stryker.config.json no parsea como JSON: ${err.message}`,
    })
    return
  }
  for (const key of ['high', 'low', 'break']) {
    const oldValue = oldConfig?.thresholds?.[key]
    const newValue = newConfig?.thresholds?.[key]
    if (typeof oldValue === 'number' && typeof newValue === 'number' && newValue < oldValue) {
      findings.push({
        blocking: true,
        summary: `umbral de mutation testing bajado en stryker.config.json: thresholds.${key} ${oldValue} -> ${newValue}`,
      })
    }
  }

  // MISMO FRAUDE, OTRA PUERTA. Si un modulo sale de `mutate`, su puntuacion ya
  // no se mide y por tanto no puede bajar del umbral: se "supera" en vacio,
  // exactamente lo que el propio stryker.config.json documenta como el motivo
  // de que packages/queue/src/index.ts saliera de la lista. Bajar el umbral
  // bloqueaba; sacar el modulo no bloqueaba nada.
  const oldMutate = Array.isArray(oldConfig?.mutate) ? oldConfig.mutate : []
  const newMutate = Array.isArray(newConfig?.mutate) ? newConfig.mutate : []
  const removed = oldMutate.filter((entry) => !newMutate.includes(entry))
  if (removed.length > 0) {
    findings.push({
      blocking: true,
      summary:
        `modulo(s) fuera de la lista \`mutate\` de stryker.config.json: ${removed.join(', ')}. ` +
        'Un modulo que no se mide no puede bajar del umbral: su puntuacion se supera en vacio',
    })
  }
}

/**
 * DETECTOR 7 — el gate no puede desaparecer sin que se note.
 *
 * Dos cosas concretas, las dos deterministas sobre el YAML:
 *   a) `ci-ok` no pierde ningun job de su lista `needs`. Quitar `test-integrity`
 *      de ahi desactivaba el gate entero sin que lo detectase nadie.
 *   b) El CI sigue invocando este script.
 *
 * LO QUE ESTO NO PUEDE HACER, y hay que decirlo: si el PR borra el job entero,
 * el job no corre y este detector tampoco. Contra eso solo valen los required
 * checks de la proteccion de rama y `.github/CODEOWNERS`, que viven fuera del
 * alcance de un script. Ver docs/quality-gates.md.
 */
function checkCiWiring(entries, mergeBase, head, findings) {
  const touched = entries.find(
    (e) => e.newPath === CI_WORKFLOW_PATH || e.oldPath === CI_WORKFLOW_PATH,
  )
  if (!touched) return
  const oldText = touched.oldPath ? gitOrNull(['show', `${mergeBase}:${touched.oldPath}`]) : null
  const newText = touched.newPath ? gitOrNull(['show', `${head}:${touched.newPath}`]) : null
  if (!oldText) return // el workflow es nuevo: no hay cableado anterior que perder
  if (!newText) {
    findings.push({ blocking: true, summary: `${CI_WORKFLOW_PATH} borrado: el CI deja de existir` })
    return
  }

  const needsOf = (text) => {
    const match = text.match(/^\s*needs:\s*\[([^\]]*)\]/m)
    if (!match) return []
    return match[1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  }
  const lost = needsOf(oldText).filter((job) => !needsOf(newText).includes(job))
  if (lost.length > 0) {
    findings.push({
      blocking: true,
      summary:
        `job(s) fuera de la lista \`needs\` de ci-ok en ${CI_WORKFLOW_PATH}: ${lost.join(', ')}. ` +
        'Un job que no esta en `needs` no bloquea el merge aunque falle',
    })
  }

  const SCRIPT_NAME = 'check-test-integrity.mjs'
  if (oldText.includes(SCRIPT_NAME) && !newText.includes(SCRIPT_NAME)) {
    findings.push({
      blocking: true,
      summary: `${CI_WORKFLOW_PATH} deja de invocar ${SCRIPT_NAME}: el gate de integridad de tests desaparece`,
    })
  }
}

/**
 * DETECTOR 8 — el manifiesto de los tests generados (T02) borrado.
 *
 * Sin manifiesto, el gate de T02 no tiene contra que comparar. Borrarlo era la
 * forma silenciosa de desactivarlo entero.
 */
function checkGeneratedTestsManifest(entries, findings) {
  const touched = entries.find((e) => e.oldPath === GENERATED_TESTS_MANIFEST_PATH)
  if (touched && touched.status === 'D') {
    findings.push({
      blocking: true,
      summary:
        `${GENERATED_TESTS_MANIFEST_PATH} borrado. Es el fichero contra el que el job ` +
        '`generated-tests` comprueba el arbol test/generated/: sin el, ese gate no compara nada',
    })
  }
}

function main() {
  const { base, head } = resolveRefs()
  const range = `${base}...${head}`

  let mergeBase
  try {
    mergeBase = git(['merge-base', base, head]).trim()
  } catch (err) {
    console.error(`ERROR: no se pudo calcular la base de comparacion (${base}...${head}).`)
    console.error(
      'En CI esto casi siempre significa checkout sin historial: el job necesita `fetch-depth: 0`.',
    )
    console.error(String(err.message ?? err))
    process.exit(1)
  }

  const pathspecs = [
    ...TEST_FILE_GLOBS,
    STRYKER_CONFIG_PATH,
    CI_WORKFLOW_PATH,
    GENERATED_TESTS_MANIFEST_PATH,
  ]
  const entries = nameStatus(range, pathspecs)

  if (entries.length === 0) {
    console.log(`Integridad de tests: sin cambios en nada que vigile este gate (${range}).`)
    process.exit(0)
  }

  const rawDiff = gitOrNull(['diff', '-U0', '-M', range, '--', ...pathspecs]) ?? ''
  const filesInDiff = parseUnifiedDiffByFile(rawDiff)

  // Los detectores de FICHEROS DE TEST no deben mirar stryker.config.json ni el
  // workflow: tienen sus propios detectores.
  const testEntries = entries.filter(
    (e) => isTestFile(e.newPath ?? '') || isTestFile(e.oldPath ?? ''),
  )

  const findings = []
  checkDeletedTestFiles(testEntries, findings)
  checkWeakenedAssertions(testEntries, mergeBase, head, findings)
  checkWeakenedMatchers(filesInDiff, findings)
  checkVacuousAssertions(filesInDiff, findings)
  checkUnjustifiedSkips(filesInDiff, findings)
  checkThresholdsInTests(filesInDiff, findings)
  checkStrykerThresholds(entries, mergeBase, head, findings)
  checkCiWiring(entries, mergeBase, head, findings)
  checkGeneratedTestsManifest(entries, findings)

  // Los avisos se imprimen SIEMPRE y no bloquean nunca. Existen para que no haya
  // ninguna via de escape invisible en la salida del gate.
  const warnings = findings.filter((f) => !f.blocking)
  const blocking = findings.filter((f) => f.blocking)
  for (const w of warnings) {
    console.log(`  AVISO  ${w.summary}`)
  }
  if (warnings.length > 0) console.log('')

  if (blocking.length === 0) {
    console.log(
      `Integridad de tests: sin hallazgos bloqueantes (${range}, ${entries.length} fichero(s) tocado(s), ` +
        `${warnings.length} aviso(s)).`,
    )
    process.exit(0)
  }

  const override = findOverride(`${mergeBase}..${head}`)

  console.log(`Integridad de tests: ${blocking.length} hallazgo(s) en ${range}.\n`)
  for (const f of blocking) {
    console.log(`  FALLA  ${f.summary}`)
  }

  if (override) {
    console.log('')
    console.log(
      `AVISO: override presente en el commit ${override.sha} — motivo: "${override.reason}"`,
    )
    console.log(
      'Los hallazgos de arriba NO bloquean por el override, pero quedan en este log y en el',
    )
    console.log('mensaje de ese commit para siempre (CLAUDE.md 2.2: trazabilidad total).')
    process.exit(0)
  }

  console.log('')
  console.log('Bloqueado. Via de escape (CLAUDE.md 2.4: "para y escala a un humano" si el hallazgo')
  console.log('es un falso positivo de un refactor legitimo): anade a un commit del PR un trailer')
  console.log('  Test-Integrity-Override: <motivo>')
  console.log('Ver la cabecera de este script para el porque de este diseno.')
  process.exit(1)
}

main()
