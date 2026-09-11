# `@coord/agents`

Los agentes de IA del epic 05 (verificación por resultados) y el único
paquete del monorepo que conoce a un proveedor de LLM. Fuera de aquí, quien
necesite un modelo pide un `LlmPort` (`packages/core/src/ports/llm.ts`); la
fitness function `anthropic-sdk-solo-en-agents` (`.dependency-cruiser.cjs`,
comprobada por `pnpm arch`) impide que `@anthropic-ai/sdk` se cuele en
cualquier otro paquete.

---

## 0. Restricción del entorno — léase antes de fiarse de nada de esto

**En ninguna máquina donde se ha escrito este paquete hay
`ANTHROPIC_API_KEY`.** Nada de aquí se ha ejecutado contra la API de
Anthropic de verdad, y nada lo intenta.

Desde el **ADR 0009** eso ya no es una laguna en la ruta que se despliega: la
producción va por el CLI de Claude Code sobre la suscripción (`claude-cli.ts`),
y `anthropic.ts` es la implementación alternativa. Lo que sigue sin ejercitarse
contra el servicio real es esa alternativa — y hay que recordarlo el día que un
disparador del ADR 0009 la ponga en producción, porque estará estrenándose.

Lo que sí está probado, con tests reales:

- El **adaptador HTTP** (`anthropic.ts`) y el **Verifier** (`verifier.ts`,
  T04) corren contra un **servidor HTTP local** que habla el protocolo de
  eventos de la API (`test/support/fake-anthropic-api.ts`). Eso ejercita la
  traducción de peticiones y respuestas, y todas las reglas de validación —
  pero no dice nada sobre si el contrato del servidor real es exactamente el
  que aquí se supone.
- La **publicación de comentarios de PR** (`report-publisher.ts` sobre
  `@coord/github`) corre contra un servidor HTTP local que habla el protocolo
  de una GitHub App (mismo patrón que ya usaba `packages/github` para los
  tokens de instalación). Tampoco hay una GitHub App **registrada** en
  ninguna máquina donde se ha escrito esto, así que nunca se ha publicado un
  comentario en un PR real.
- La **tasa de falso aprobado del Verifier** (`trap-suite.ts`) ya está medida,
  pero **no contra el modelo de producción**. Ver la sección siguiente.

Léase: **"los tests están en verde" no significa "probado contra Claude" ni
"publicado en GitHub".** Contra Claude ya hay una medida real por CLI (sección
siguiente), que es la ruta que se despliega. Lo que falta es la llamada de humo
contra **GitHub**, en cuanto haya una App registrada.

---

## 0.1. La medida del banco de trampas, y qué no dice

Corrido el **11 de septiembre de 2026** con `pnpm --filter @coord/agents
measure:trap-suite`, es decir, por el adaptador de CLI (`claude-cli.ts`) sobre
una suscripción de Claude Code, **con la configuración de producción**
(`claude-opus-5`, `effort: xhigh`):

```
Tasa de falso aprobado:  0.0%  (0/6 trampas aprobadas)
Tasa de falso rechazo:   0.0%  (0/1 casos limpios bloqueados)
Criterios en desacuerdo: 0
Consumo: 14.940 tokens de salida
```

Es la primera medida del **modelo y la ruta que se despliegan**. Hasta el
issue #27 no se podía tomar: `claude-opus-5` rechazaba la petición entera.

**Lo que esta cifra sigue sin decir, y hay que decirlo cada vez que se cite:**

1. **n = 7.** Seis trampas y un caso limpio. Un 0 % sobre seis muestras no
   significa "no se le cuela nada": el intervalo de confianza es enorme (el
   techo al 95 % ronda el 40 %). Esto es un suelo, una comprobación de que el
   instrumento mide y de que el Verifier no cae en las trampas obvias. **No es
   una tasa de precisión.**

2. **El aislamiento es una lista de banderas, no una propiedad del
   transporte.** Es el precio del ADR 0009, está escrito allí, y no cambia
   porque la cifra haya salido bien. Tampoco hay salida estructurada
   garantizada por el servidor.

3. **Una tasa no es transferible entre modelos.** Esta es de `claude-opus-5`.
   La anterior, del 9 de septiembre, era de `claude-sonnet-5` y daba lo mismo
   en las dos tasas pero **un criterio en desacuerdo**: en
   `07-inyeccion-en-el-diff`, Sonnet no se dejó engañar pero contestó
   `SIN_EVIDENCIA` donde el banco espera `FAIL`. Opus contesta `FAIL`.
   **No se tocó el veredicto esperado del banco para que cuadrara** cuando no
   cuadraba: ajustar la expectativa a lo que responde el modelo es la señal de
   alarma de `CLAUDE.md` §7, y por eso el desacuerdo estuvo escrito aquí dos
   días en vez de desaparecer. Que ahora cuadre es un dato sobre el modelo, y
   sobre un solo caso: no lo conviertas en "Opus entiende las inyecciones".

---

## 1. Qué hace cada pieza

```
packages/agents/src/
├── anthropic.ts                          T01 — adaptador de LlmPort sobre @anthropic-ai/sdk
└── verification/
    ├── test-manifest.ts                  T02 — manifiesto firmado del árbol de tests generados
    ├── generated-tests-fs.ts             T02 — E/S de ese manifiesto
    ├── test-generator.ts                 T02 — genera tests SOLO a partir de los criterios
    ├── tamper-audit.ts                   T02 — registra en audit_log un intento de manipulación
    ├── verifier.ts                       T04 — el Verifier en contexto aislado
    ├── trap-suite.ts                     T04 — banco de diffs con trampas conocidas (instrumento)
    ├── report.ts                         T05 — la estructura del informe + veredicto global binario
    ├── report-render.ts                  T05 — los dos renderizados, con presupuesto de pantalla
    └── report-publisher.ts               T05 — publica el Markdown como comentario de PR
```

### T01 — `anthropic.ts`

Traduce el `LlmPort` del dominio a peticiones de `@anthropic-ai/sdk`.
Concentra **todas** las formas de la API que cambiaron en 2025-2026: ids de
modelo sin sufijo de fecha, `thinking: { type: 'adaptive' }`, el esfuerzo
dentro de `output_config`, salida estructurada vía `output_config.format`,
sin prefill del turno `assistant`, y `stop_reason: 'refusal'` comprobado
antes de leer el contenido. Exporta `VERIFIER_MODEL` (`claude-opus-5`) y
`TEST_GENERATOR_MODEL` (`claude-sonnet-5`), las únicas cadenas de modelo que
existen en el repositorio.

### T02 — generación de tests (`test-generator.ts` y satélites)

Un agente **distinto** al que implementa —`claude-sonnet-5`, esfuerzo
`high`— escribe los tests a partir de los criterios de aceptación, nunca del
código. `TestGenerationRequest` no tiene ni un campo para la implementación
y el módulo no toca el disco: el primer criterio de T02 ("el generador no ha
visto la implementación") se cumple por construcción, no por promesa del
prompt. `test-manifest.ts` firma el árbol resultante para poder detectar
manipulación después; `tamper-audit.ts` deja constancia en `audit_log`
cuando alguien lo intenta.

### T04 — `verifier.ts` y `trap-suite.ts`

El Verifier corre en contexto limpio —`claude-opus-5`, esfuerzo `xhigh`— y
recibe exactamente tres cosas: los criterios de aceptación, el diff final y
la salida literal de los tests. `VerificationInput` es un tipo **cerrado**
sin un solo campo de texto libre (nada de `prDescription`, `notes`,
`context`...), así que el aislamiento del primer criterio de T04 es una
propiedad del tipo, comprobada por `pnpm -r typecheck` con un
`@ts-expect-error`, no una instrucción que alguien pueda olvidar.

Cada veredicto (`PASS` / `FAIL` / `SIN_EVIDENCIA`) trae razonamiento **antes**
del veredicto y una cita literal del criterio y de la evidencia; las dos
citas se comprueban **a máquina** contra su fuente
(`assertQuoteIsVerbatim`), así que una cita inventada o parafraseada tumba el
informe entero en vez de colarse. `allCriteriaPass()` es la regla de
aprobación: **todos** PASS, o no se aprueba — `SIN_EVIDENCIA` no es un "sí"
con reservas.

`trap-suite.ts` es el banco de diffs con trampas conocidas (test borrado,
valor hardcodeado, aserción debilitada, catch que traga, criterio
imposible, inyección de prompt en el propio diff) y calcula las tasas de
falso aprobado y falso rechazo **cuando se corre contra un modelo real**. Es
el instrumento; la medida, como se dice arriba, no está hecha.

### T05 — el informe de conformidad (`report.ts`, `report-render.ts`, `report-publisher.ts`)

La pieza de este documento. Ver la sección 2.

---

## 2. T05 en detalle

### 2.1 `report.ts` — la estructura

`buildConformanceReport(result: VerificationResult): ConformanceReport`
reempaqueta el veredicto de T04 sin inventar nada nuevo:

- `globalVerdict: 'apto' | 'no_apto'` — **binario**, nunca una puntuación.
  Se calcula reutilizando `allCriteriaPass()` de `verifier.ts` en vez de
  reimplementar la regla ("un solo FAIL o SIN_EVIDENCIA hace el conjunto no
  apto") por segunda vez, con el riesgo de que un día diverjan.
- `verdicts` — el array de `CriterionVerdict` de T04 **campo a campo**, sin
  resumir ni reescribir. Es lo que garantiza que no se pierde evidencia entre
  el Verifier y el informe; `report.test.ts` lo comprueba comparando
  elemento a elemento.

No hay ni un campo de tipo `score` o `percentage`: el epic prohíbe la escala
1-10 explícitamente ("invita a negociar consigo mismo"), y un campo que hoy
no usa nadie es justo el hueco por el que un día se cuela.

### 2.2 `report-render.ts` — los dos renderizados y "cabe en una pantalla"

`renderConformanceReportMarkdown()` (para el comentario de PR) y
`renderConformanceReportPlainText()` (para la CLI) parten de la **misma**
estructura interna (`ReportPlan`) y solo difieren en cómo la formatean, así
que no pueden decir cosas distintas — no hay dos caminos de lógica que
puedan divergir.

"Cabe en una pantalla" es `DEFAULT_SCREEN_BUDGET = { maxLines: 80, maxChars:
8000 }`, no una frase. Las dos cifras están documentadas en la cabecera del
fichero (80 líneas ≈ un terminal maximizado a fuente por defecto, y
aproximadamente lo que se ve en el primer pantallazo de un comentario de PR
de GitHub; 8000 caracteres da margen sobre 80 columnas × 80 líneas para citas
largas) y **se miden**: cada render devuelve `lineCount`, `charCount` y
`fitsOnScreen`, y `report-render.test.ts` los comprueba renderizando
informes de 3 y de 40 criterios, no leyendo el código y confiando en que
"parece corto".

Cuando el informe completo no cabe, se trunca por lo que menos importa:

1. Primera pasada: todo con detalle completo (razonamiento + las dos citas).
   Si cabe, se devuelve así.
2. Si no cabe: los criterios **PASS** se reducen a una línea (`- PASS ·
<id>`); los **FAIL** y **SIN_EVIDENCIA** conservan su detalle completo,
   siempre, sin excepción — es una decisión binaria por veredicto, no una
   escala de "cuánto recortar", porque en cuanto se admite "un FAIL un poco
   más corto" ya no hay un sitio obvio donde parar. El informe dice cuántos
   PASS se resumieron.
3. Si aun así no cupiera (muchos FAIL con razonamientos largos), la función
   **no sigue recortando**: devuelve el informe compactado con
   `fitsOnScreen: false` en vez de fingir que cupo. Ocultar un FAIL para
   caber es peor que un informe largo (CLAUDE.md §7), y esta función nunca lo
   hace — hay un test que fuerza justo ese caso y comprueba que el FAIL sigue
   entero.

### 2.3 `report-publisher.ts` — publicación en el PR

`publishConformanceReport(app, target, report)` renderiza el Markdown y lo
publica reutilizando `@coord/github` — en concreto la función nueva
`publishPullRequestComment()` de ese paquete, que a su vez usa
`app.getInstallationOctokit(installationId)` y
`octokit.rest.issues.createComment(...)`. `octokit` sigue siendo un detalle
de implementación exclusivo de `packages/github` (regla
`octokit-solo-en-github`): este fichero recibe el `App` como un tipo
**opaco**, extraído de la propia firma de `publishPullRequestComment` con
`Parameters<typeof publishPullRequestComment>[0]`, así que nunca escribe un
`import` a `@octokit/*` y `pnpm arch` lo comprueba.

**Efecto colateral encontrado al escribir esto:** `createGitHubApp()`
(`packages/github/src/app.ts`) solo pasaba el `Octokit` con `.rest.*` cuando
había un `baseUrl` de test; en producción (sin `baseUrl`) `@octokit/app` caía
a `@octokit/core` pelado, **sin `.rest`**. Antes de T05 nada del
repositorio llamaba a `.rest.*`, así que el hueco no se había notado — pero
era un fallo real de producción, no solo de tipos: `getInstallationOctokit()`
habría devuelto un cliente incapaz de publicar el comentario. Se corrigió en
`app.ts` para todo el mundo (siempre se usa el `Octokit` con plugins, con o
sin `baseUrl`), no con un cast local en `pull-request-comments.ts`.

Ni `pull-request-comments.ts` (en `packages/github`) ni `report-publisher.ts`
atrapan los errores de transporte (404, 403, timeouts): se propagan tal
cual. Un `catch` que los tragara aquí dejaría creer que el informe llegó al
humano cuando no llegó — el fallo silencioso que el epic 05 existe para
evitar.

---

## 3. Un ejemplo real del informe

Esto es la salida **real** de `renderConformanceReportMarkdown()` y
`renderConformanceReportPlainText()` sobre un `VerificationResult` de tres
criterios (uno de cada veredicto), para poder juzgar el formato sin tener
que ejecutar nada. No está retocado a mano.

### Markdown (lo que se publica como comentario de PR)

```markdown
# Informe de conformidad — issue-18

**Veredicto global: NO APTO**

Modelo: `claude-opus-5` · PASS: 1 · FAIL: 1 · SIN_EVIDENCIA: 1 · Total: 3

### 1. PASS — crit-1

**Criterio:** "cuando un agente intenta reclamarla, entonces el claim se rechaza"
**Evidencia** (diff): "+ if (!task.criteriaApproved) {

- throw new ConflictError('criterios no aprobados')
- }"
  **Razonamiento:** El criterio pide que un claim sobre una tarea sin criterios aprobados se rechace. El diff añade la comprobación al inicio de claim() en packages/core/src/claims.ts, antes de tocar la base de datos, y lanza ConflictError con el mensaje "criterios no aprobados". La salida de tests confirma que el test nuevo pasa y que el resto de la suite de claims.ts sigue en verde.

### 2. SIN_EVIDENCIA — crit-2

**Criterio:** "entonces es observable y acotado: se puede señalar la salida"
**Evidencia** (test_output): "9 passed | 0 failed (acceptance-criteria.test.ts, sin casos nuevos de assertThenIsObservable)"
**Razonamiento:** El criterio exige que el `then` de un criterio señale algo observable: una salida, un código de respuesta o un fichero. El diff no toca la validación de `assertThenIsObservable`; la salida de tests no incluye ningún caso nuevo que la ejercite con un `then` no observable. No hay evidencia de que este criterio se haya tocado en este cambio.

### 3. FAIL — crit-3

**Criterio:** "requiere re-aprobación"
**Evidencia** (diff): "+ expect(result).toBeDefined()"
**Razonamiento:** El criterio exige que un cambio en los criterios después de aprobados quede registrado (quién y cuándo) y requiera re-aprobación. El diff sí añade un campo `approvedAt` pero el test que lo comprueba usa `expect(result).toBeDefined()` en vez de comprobar que `approvedAt` vuelve a `null` tras el cambio: es exactamente la aserción debilitada que CLAUDE.md pide tratar como FAIL aunque los tests estén en verde.
```

Medido: 22 líneas, 1885 caracteres — muy por debajo de `DEFAULT_SCREEN_BUDGET`
(80 líneas, 8000 caracteres); `fitsOnScreen: true`.

### Texto plano (lo que ve quien usa la CLI)

```
INFORME DE CONFORMIDAD — issue-18
=================================

VEREDICTO GLOBAL: NO APTO

Modelo: claude-opus-5 | PASS: 1 · FAIL: 1 · SIN_EVIDENCIA: 1 · Total: 3

1. PASS — crit-1
   Criterio: "cuando un agente intenta reclamarla, entonces el claim se rechaza"
   Evidencia (diff): "+  if (!task.criteriaApproved) {
+    throw new ConflictError('criterios no aprobados')
+  }"
   Razonamiento: El criterio pide que un claim sobre una tarea sin criterios aprobados se rechace. El diff añade la comprobación al inicio de claim() en packages/core/src/claims.ts, antes de tocar la base de datos, y lanza ConflictError con el mensaje "criterios no aprobados". La salida de tests confirma que el test nuevo pasa y que el resto de la suite de claims.ts sigue en verde.

2. SIN_EVIDENCIA — crit-2
   Criterio: "entonces es observable y acotado: se puede señalar la salida"
   Evidencia (test_output): "9 passed | 0 failed (acceptance-criteria.test.ts, sin casos nuevos de assertThenIsObservable)"
   Razonamiento: El criterio exige que el `then` de un criterio señale algo observable: una salida, un código de respuesta o un fichero. El diff no toca la validación de `assertThenIsObservable`; la salida de tests no incluye ningún caso nuevo que la ejercite con un `then` no observable. No hay evidencia de que este criterio se haya tocado en este cambio.

3. FAIL — crit-3
   Criterio: "requiere re-aprobación"
   Evidencia (diff): "+  expect(result).toBeDefined()"
   Razonamiento: El criterio exige que un cambio en los criterios después de aprobados quede registrado (quién y cuándo) y requiera re-aprobación. El diff sí añade un campo `approvedAt` pero el test que lo comprueba usa `expect(result).toBeDefined()` en vez de comprobar que `approvedAt` vuelve a `null` tras el cambio: es exactamente la aserción debilitada que CLAUDE.md pide tratar como FAIL aunque los tests estén en verde.
```

Medido: 23 líneas, 1890 caracteres; `fitsOnScreen: true`.

Nótese que con un solo FAIL (`crit-3`) el veredicto global es **NO APTO**
aunque haya un PASS: la regla es "todos PASS o no se aprueba", no "la
mayoría".

Con 40 criterios, la misma llamada resume los PASS a una línea cada uno
(`- PASS · <id>`) y conserva íntegros el FAIL y el SIN_EVIDENCIA, con una
nota que dice cuántos PASS se resumieron — es exactamente lo que comprueba
`report-render.test.ts`.

---

## 4. Lo que este paquete NO puede garantizar

El primer criterio de aceptación de T05 dice: _"dado un PR verificado, cuando
el humano abre el informe, entonces puede decidir sin abrir el diff"_. Eso es
una propiedad de **la persona** que lee el informe, no del código — ningún
test puede demostrar que un lead concreto decidió bien con esto delante. Lo
que sí se garantiza, con test:

- el informe contiene **todo** lo necesario para decidir (cada criterio con
  su cita de evidencia, los `SIN_EVIDENCIA` tan visibles como los `FAIL`);
- esa evidencia **no se pierde** entre el veredicto de T04 y el informe;
- el informe **cabe** en el presupuesto declarado, o dice explícitamente que
  no cupo y por qué (cuántos PASS se resumieron) — nunca oculta un FAIL para
  parecer que cupo.

Como reconoce el propio epic en "Huecos conocidos", el diseño exacto de este
informe **necesita iterarse con el lead real del piloto** antes de darlo por
bueno: nada de esta sección ni de sus tests sustituye esa validación.

---

## 5. Comandos

```bash
pnpm --filter @coord/agents typecheck
pnpm --filter @coord/agents build
pnpm --filter @coord/agents test
pnpm arch                          # fitness functions, incluida octokit-solo-en-github
```

`verify:generated-tests` y `measure:trap-suite` son ejecutables (`tsx`), no
se reexportan desde `src/index.ts` para que importar el paquete no los
dispare.
