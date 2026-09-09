# Estructura del repo y gates de calidad

---

## 1. Estructura del monorepo

```
/
├── CLAUDE.md                    # constitución — se carga en todo agente
├── AGENTS.md                    # symlink o copia, para agentes que no leen CLAUDE.md
├── .claude/
│   ├── prds/                    # PRDs (CCPM)
│   ├── epics/                   # epics y tareas (CCPM)
│   └── skills/                  # skills locales, incl. ponytail
├── docs/
│   ├── adr/                     # decisiones de arquitectura, numeradas
│   ├── arquitectura.md          # arc42 ligero: contexto, estrategia, bloques, despliegue
│   ├── runbook.md               # qué hacer cuando algo falla
│   └── quality-gates.md         # este documento
├── apps/
│   ├── webhook/                 # listener de webhooks de GitHub (fino, solo encola)
│   ├── worker/                  # procesadores de la cola
│   └── daemon/                  # companion que corre en la máquina de cada dev
├── packages/
│   ├── db/                      # esquema, migraciones, capa de acceso con RLS
│   ├── queue/                   # interfaz sobre pg-boss
│   ├── github/                  # cliente de la GitHub App, gestión de tokens
│   ├── graph/                   # grafo de dependencias (Fase 1)
│   ├── agents/                  # los cinco agentes de IA (Fases 2-4)
│   └── core/                    # dominio — no depende de nada de arriba
├── infra/                       # docker-compose, PgBouncer, más adelante Terraform
└── .github/workflows/           # CI
```

**Regla de dependencias:** `core` no importa de `apps/` ni de `packages/db`,
`packages/github`, etc. Las dependencias apuntan hacia dentro. Esto no es una
sugerencia: lo comprueba una fitness function en CI (T06).

---

## 2. Gates de calidad — las tres capas

### Capa 1: guía (el agente puede ignorarla)

`CLAUDE.md`, `AGENTS.md`, y el plugin `ponytail`. Moldean cómo escribe el agente,
pero son texto en el prompt. Necesarias, no suficientes.

### Capa 2: determinista (el agente no puede saltársela)

Hooks de pre-commit + CI. Aquí es donde las reglas se vuelven reales.

| Check                              | Herramienta                                | Cuándo                              | Bloquea                                    |
| ---------------------------------- | ------------------------------------------ | ----------------------------------- | ------------------------------------------ |
| Formato y lint                     | linter del stack                           | pre-commit + CI                     | sí                                         |
| Type-check                         | `tsc`                                      | pre-commit + CI                     | sí                                         |
| Secretos                           | Gitleaks / TruffleHog                      | pre-commit                          | sí                                         |
| Tests                              | runner del stack                           | CI                                  | sí                                         |
| SCA de dependencias                | Dependabot                                 | continuo                            | crítico/alto                               |
| SAST                               | Semgrep o CodeQL                           | CI                                  | crítico/alto                               |
| IaC                                | Trivy / Checkov                            | CI (cuando haya Terraform)          | crítico/alto                               |
| Fitness functions de arquitectura  | dependency-cruiser                         | CI                                  | sí                                         |
| Integridad de tests (manipulación) | script propio (`check-test-integrity.mjs`) | CI, cada PR                         | sí, con escapatoria auditable              |
| Mutation testing                   | Stryker                                    | workflow separado, módulos críticos | bajo umbral, al ejecutarse (no en cada PR) |
| Calidad / deuda técnica            | SonarQube Server self-hosted               | CI                                  | quality gate                               |

**Por qué SonarQube self-hosted y no cloud:** manejamos código de clientes con
obligaciones de residencia de datos en la UE. La Community Edition es gratis,
corre en un contenedor, y el código no sale de nuestra infraestructura. Cuando
un cliente exija "el código no puede salir de nuestra red", esta es la respuesta.

**Ojo con las herramientas "locales":** si una herramienta corre en local pero
manda el código a una API externa de IA, el código SÍ sale. Verificar herramienta
por herramienta, no asumir por el nombre.

#### Integridad de tests: detección de manipulación (Epic 05 / T03, Issue #23)

Epic 05 arranca de una premisa incómoda: "se diseña asumiendo que el agente
hará trampa, porque está documentado que lo hace". El job `test-integrity` de
`ci.yml` corre `scripts/check-test-integrity.mjs` sobre `git diff
origin/main...HEAD` en cada PR (necesita `fetch-depth: 0` en el checkout, o no
hay con qué calcular la base de comparación) y bloquea si encuentra:

- **Ficheros de test borrados.**
- **Aserciones debilitadas:** el total de `expect(`/`assert(`/`.toThrow(`/
  `.rejects` en los ficheros de test tocados baja entre la base y la cabeza.
  Se cuenta el **total**, no por fichero, a propósito: un refactor legítimo
  mueve tests entre ficheros, y contar por fichero confundiría "movido" con
  "borrado". Si el total baja de verdad, algo se debilitó.
- **Aserciones vacuas añadidas:** `expect(true).toBe(true)`, `expect(1).toBe(1)`,
  `assert(true)` y familia — comparaciones que no pueden fallar nunca.
- **`skip`/`only`/`todo` añadidos** sin un comentario en la misma línea del
  diff que lo explique.
- **Umbrales que bajan:** `thresholds.{high,low,break}` en
  `stryker.config.json`, y comparaciones numéricas (`toBeGreaterThan(N)` y
  familia) donde la línea añadida repite la línea borrada del mismo hunk con
  un número menor.

**La escapatoria, porque un gate sin escape se acaba desactivando entero:** un
commit del PR con un trailer `Test-Integrity-Override: <motivo>` desactiva el
bloqueo — pero no el aviso: los hallazgos se siguen imprimiendo en el log del
job, junto al SHA del commit que los justificó, así que quedan auditables para
siempre en el historial de git (CLAUDE.md 2.2). No hay override selectivo por
hallazgo, es todo o nada: más código para un caso raro, y el motivo del
trailer ya dice a qué se aplica.

**Sobre el hardcodeo de valores esperados — honestidad, no falsa precisión:**
el criterio de aceptación de T03 pide que "al menos una capa" detecte un PR
que hardcodea el valor esperado en vez de calcularlo. Este script **no lo
persigue con regex** — no hay forma sintáctica fiable de distinguir
`expect(total).toBe(42)` legítimo de uno que copió el resultado observado en
vez de calcularlo. Lo único que este gate aporta a ese problema es el
detector de aserciones vacuas de arriba (`expect(1).toBe(1)`), que cubre el
caso extremo — un literal contra sí mismo — no el caso general. **La
detección real la dan otras dos capas, no esta:** el mutation testing (un
valor hardcodeado sobrevive a mutaciones porque no depende de la lógica que
se mutó) y el Verifier en contexto aislado (T04, ve el spec y el diff y puede
razonar semánticamente). Si se lee "el gate de integridad detecta valores
hardcodeados", es una lectura equivocada de lo que hace.

**Demostrado localmente** (no en un run de Actions real, que este entorno no
puede disparar): cada detector se probó provocando su violación exacta en una
rama temporal fabricada con `git worktree` y borrada después — fichero de
test borrado, aserción quitada sin borrar el fichero, `expect(true).toBe(true)`
añadido, `it.skip` sin comentario, umbral de `stryker.config.json` bajado, y
un umbral numérico dentro de un test bajado — los seis en rojo con el mensaje
esperado; y un refactor legítimo (mover un test a otro fichero, mismo total de
aserciones) en verde, para comprobar que el caso legítimo no dispara el gate.
El override se probó por separado: mismo diff que borra un test, con el
trailer en el commit, sale en verde con el aviso impreso.

### Capa 3: verificación por resultados (Fase 4)

El Verifier en contexto aislado, comprobando conformidad con el spec. No
sustituye a las capas 1 y 2, se apoya en ellas.

---

## 3. Frontera: quién comprueba qué

Para no duplicar esfuerzo entre las herramientas compradas y los agentes propios:

| Pregunta                                                        | Quién responde                                  |
| --------------------------------------------------------------- | ----------------------------------------------- |
| ¿Este diff es mantenible, idiomático, sin code smells?          | SonarQube                                       |
| ¿Este diff tiene vulnerabilidades o dependencias comprometidas? | SAST + SCA                                      |
| ¿Este diff respeta las fronteras de arquitectura?               | Fitness functions                               |
| ¿Hacía falta escribir todo esto?                                | ponytail (antes) + `/ponytail-review` (después) |
| ¿Este trabajo cumple los criterios de aceptación del spec?      | **Verifier propio**                             |
| ¿Quién debería hacer esta tarea?                                | **Router propio**                               |
| ¿Esta tarea choca con otra en curso?                            | **Detección de colisiones propia**              |

Todo lo de la columna izquierda que no está en negrita **se compra o se usa
open-source**. Lo de negrita es lo único que construimos, porque es lo que no
existe en el mercado.

---

## 4. Stack de agentes instalado

| Pieza                        | Qué hace                                                                                                 | Fase |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ---- |
| CCPM                         | Motor de ejecución: PRD → Epic → Task → Issue                                                            | 0    |
| ponytail                     | Escalera de minimalismo antes de generar código; `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt` | 0    |
| Task Router (propio)         | Sugiere a qué persona dar cada tarea                                                                     | 2    |
| Heartbeat Brain (propio)     | Clasifica estado del agente desde telemetría                                                             | 3    |
| Collision Predictor (propio) | Predice archivos afectados antes de codear                                                               | 3    |
| Verifier (propio)            | Conformidad con spec, en contexto aislado                                                                | 4    |
| Docs Generator (propio)      | Informes de cliente desde artefactos de CCPM                                                             | 5    |

`/ponytail-debt` cubre parte del seguimiento de deuda técnica: recoge los
atajos marcados como diferidos en un ledger, para que "luego" no se convierta
en "nunca". Conviene revisarlo al cierre de cada epic.

---

## 5. Presupuesto de tokens

Los agentes de código corren sobre suscripciones ya pagadas. Los agentes propios
(router, verifier, heartbeat) van por API y hay que vigilarlos:

- Caché de prompts en todo prompt de sistema estático.
- Modelo por rol: el clasificador de heartbeats es el más barato disponible y
  sin extended thinking; el Verifier es el más capaz y con thinking alto.
- Tope de coste por tarea, y alerta si un agente lo supera.
- El heartbeat vigila la quema anómala: es la defensa contra el bucle infinito
  que multiplica la factura.
