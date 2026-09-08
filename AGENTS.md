# AGENTS.md

La constitución completa de este proyecto vive en [`CLAUDE.md`](./CLAUDE.md), en la
raíz del repo. Este fichero es un resumen para agentes que no cargan `CLAUDE.md`
automáticamente. Si tienes acceso a `CLAUDE.md`, léelo entero: esto es solo un resumen.

## Resumen

- **Qué construimos:** una capa de coordinación de equipos encima de GitHub Issues,
  CCPM y agentes de código. Reparte tareas entre personas, evita colisiones entre
  agentes de distintos devs, y permite supervisar sin leer el diff.
- **El humano decide.** Los agentes proponen, nunca aprueban su propio trabajo ni
  deciden merges a `main` en solitario.
- **Trazabilidad total:** Discovery → PRD → Epic → Task → GitHub Issue → Commit.
  Commits con formato `Issue #N: descripción`. Sin issue, no hay commit.
- **El verificador nunca es el generador.** Quien escribe el código no lo valida.
- **Escalera de pereza antes de codear:** ¿hace falta? → ¿ya existe? → ¿lo hace la
  stdlib? → ¿feature nativa? → ¿dependencia ya instalada? → ¿una línea? → mínimo que
  funciona. Nunca recortes seguridad, validación en fronteras de confianza, manejo de
  pérdida de datos ni accesibilidad.
- **Multi-tenant desde el diseño:** toda fila lleva `tenant_id`, RLS forzada, ningún
  query sin scope de tenant.
- **Arquitectura:** dependencias apuntan hacia dentro; `packages/core` no depende de
  nada del repo. Sin ciclos. Enforced con dependency-cruiser en CI.
- **Nunca `catch` silencioso.** Si no sabes qué hacer con un error, propágalo.
- **Secretos jamás en el repo**, ni en tests ni en fixtures.
- **No construyas** lo que está en la tabla de "no construir todavía" de
  `CLAUDE.md` §4 (Redis, Neo4j, SSO, multi-DB por tenant, etc.) sin que se cumpla su
  disparador.
- Las reglas que de verdad importan están automatizadas en hooks de pre-commit y CI
  (ver `docs/quality-gates.md`), no solo escritas aquí.

Ante la duda, `CLAUDE.md` manda.
