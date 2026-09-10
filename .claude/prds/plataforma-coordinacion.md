# PRD — Plataforma de coordinación humano-agente

**Estado:** borrador para revisión humana
**Owner:** Javier
**Fecha:** septiembre 2026

---

## 1. Problema

Un equipo de 3 a 5 desarrolladores, cada uno usando su propio agente de código
(Claude Code, Codex, Copilot CLI), sobre un repo compartido. Hoy pasa esto:

- **Trabajo duplicado.** Dos personas atacan la misma cosa sin saberlo.
- **Colisiones de archivos.** Los git worktrees aíslan, pero no coordinan: nadie
  decide quién debería intentar qué tarea, y el conflicto aparece en el merge.
- **Supervisión insostenible.** Para confiar en lo que hizo un agente hay que
  leer el diff línea a línea. Con varios agentes produciendo en paralelo, eso
  no escala y la gente deja de revisar de verdad.
- **Ceguera de estado.** No se sabe si el agente de un compañero sigue vivo,
  avanzando, o lleva 40 minutos en bucle quemando tokens.

Las herramientas existentes (CCPM, CAO, Orkas, Sharkly, Dailybot, Augment
Intent, Linear) resuelven trozos: orquestación de subagentes de una sola
persona, o visibilidad de estado, o verificación. Ninguna cubre a la vez el
reparto **entre humanos**, la prevención de colisiones **entre personas**, y la
supervisión **sin diffs**.

## 2. Usuarios

**Primario:** el lead técnico de un equipo pequeño (Javier en Liberion) que
tiene que repartir trabajo y responder por la calidad sin convertirse en un
cuello de botella de revisión.

**Secundario:** cada desarrollador del equipo, que quiere saber si su agente va
bien sin mirar la terminal, y no quiere descubrir en el merge que otro tocó lo
mismo.

**Terciario (fase producto):** equipos de 3-50 personas fuera de Liberion con
el mismo problema, y sus responsables de compras/seguridad.

## 3. Criterios de éxito

Medibles, en el propio uso interno de Liberion durante el piloto:

| Métrica | Baseline hoy | Objetivo |
|---|---|---|
| Colisiones descubiertas en merge (por sprint) | medir en semana 1 | reducir a la mitad |
| Tiempo del lead revisando diffs (h/semana) | medir en semana 1 | reducir a la mitad |
| Tareas duplicadas detectadas | medir en semana 1 | cero no detectadas antes de empezar |
| Agentes atascados detectados por el sistema antes que por la persona | 0% | >70% |

Si tras el piloto no se mueve ninguna de estas, el producto no resuelve el
problema y hay que replantear, no seguir construyendo.

## 4. Alcance de la v1

### Dentro

1. **Grafo de dependencias del código** — construcción incremental, consultas
   de dependencias inversas, expuesto como herramientas MCP.
2. **Detección de colisiones** — claim/lease sobre issues y archivos, aviso de
   solapamiento semántico y por grafo antes de empezar.
3. **Asignación asistida** — shortlist ranqueada de a quién dar cada tarea, con
   justificación. Decisión humana.
4. **Heartbeats y estado** — daemon local en cada máquina, detección de bucles,
   estancamiento y quema anómala de coste.
5. **Verificación por resultados** — criterios Given/When/Then aprobados antes
   de codear, gate determinista en CI, Verifier en contexto aislado, informe de
   conformidad en vez de diff.
6. **Multi-tenant** — varios proyectos/clientes en la misma instancia, aislados.

### Fuera de la v1 (explícitamente)

- Interfaz gráfica pulida. La v1 vive en GitHub Issues, comentarios y CLI.
- Soporte a agentes que no sean Claude Code / Codex / Copilot CLI.
- Agente de despliegue Terraform/Azure (va en v2, ya investigado).
- Generación de documentación de cliente (v2).
- SSO, SCIM, audit logs enterprise (solo cuando un cliente lo pida por escrito).
- Cualquier cosa de la tabla "no construir todavía" de `CLAUDE.md`.

## 5. Restricciones

- **Equipo:** 3 personas, a tiempo parcial. Todo lo que se pueda comprar en vez
  de construir, se compra.
- **Coste:** debe correr sobre suscripciones ya pagadas de los agentes de
  código, no sobre API de pago por token. **Esto incluye las llamadas propias de
  la plataforma (router, Verifier)**, que corren por el CLI de Claude Code sobre
  la misma suscripción — ver `docs/adr/0009-todo-sobre-la-suscripcion-de-claude-code.md`.

  Este renglón decía lo contrario hasta el 10 de septiembre de 2026: mandaba
  router y Verifier por API "y hay que presupuestarlas". Se escribió antes de
  construir nada, y sus tres razones no aguantaron la medición — el CLI también
  devuelve el consumo por llamada, la salida estructurada no evita validar, y el
  aislamiento del Verifier se pudo construir y verificar. Lo que sí se acepta a
  cambio está en las consecuencias de ese ADR, y no es menor: el aislamiento pasa
  de ser una propiedad del transporte a una lista de banderas que hay que
  mantener.
- **Datos:** código de clientes. Residencia de datos en la UE. Opción
  self-hosted obligatoria para clientes que lo exijan.
- **Legal:** GDPR/LOPDGDD desde el día uno. DPA listo antes del primer cliente
  con datos personales.

## 6. Supuestos que hay que validar

- Que el reparto asistido por IA acierta lo bastante como para que el lead lo
  use en vez de ignorarlo. **Validar en el piloto midiendo cuántas veces se
  anula la sugerencia.**
- Que un informe de conformidad genera suficiente confianza como para aprobar
  sin abrir el diff. **Validar preguntando al lead, no asumiéndolo.**
- Que la predicción de archivos afectados antes de escribir código tiene
  recall suficiente. **Validar contra PRs ya mergeados del propio repo.**

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| El agente hace trampa en la verificación (borra tests, hardcodea) | Verifier en contexto aislado + mutation testing + detección de edición de tests |
| Falsos positivos de colisión que la gente aprende a ignorar | Empezar como aviso, nunca como bloqueo. Medir tasa de acierto antes de endurecer |
| Sobre-ingeniería: construir para enterprise sin tener clientes enterprise | Tabla de "no construir" en `CLAUDE.md`, con disparadores explícitos |
| El piloto no mueve ninguna métrica | Aceptar y replantear, no seguir por inercia |

## 8. Preguntas abiertas

- ¿Qué pasa cuando el gate de verificación es ambiguo? Flujo de reasignación y
  re-verificación **sin diseñar todavía**. Bloquea la Fase 4, no las primeras.
- ¿Cómo se ve exactamente el informe de conformidad para que genere confianza y
  no sea otra notificación ignorada? **Sin diseñar.**
- ¿Qué proyecto real de Liberion es el piloto? **Sin decidir.**
