# ADR 0001 — Postgres con esquema compartido y RLS forzada, no una base de datos por tenant

**Estado:** Aceptada

## Contexto

El sistema es multi-tenant desde el primer día (CLAUDE.md 2.6): datos de
distintos equipos y distintos clientes de Liberion Labs conviven en la misma
plataforma. Hay que decidir el modelo de aislamiento de datos entre tenants
antes de escribir el primer esquema, porque cambiarlo después implica migrar
datos en producción.

Las opciones habituales son: base de datos separada por tenant, esquema
separado por tenant dentro de la misma base, o esquema compartido con una
columna `tenant_id` y aislamiento forzado por Row Level Security (RLS).

## Decisión

Un único Postgres, esquema compartido. Toda tabla de datos lleva `tenant_id`
como columna obligatoria. RLS activada y **forzada** (`FORCE ROW LEVEL
SECURITY`) en cada tabla, con políticas que filtran por el tenant activo en la
sesión. El aislamiento no depende de que cada query recuerde añadir
`WHERE tenant_id = ...`: lo garantiza la base de datos.

## Consecuencias

- Escala a cientos de miles de tenants sin multiplicar el número de bases de
  datos ni la complejidad operativa (backups, migraciones, monitorización se
  hacen una vez, no N veces).
- Coste operativo bajo comparado con aprovisionar infraestructura por tenant.
- El motor de RLS de Postgres pasa a ser un componente crítico de seguridad:
  hace falta un test automatizado de aislamiento entre tenants (T02) y
  disciplina en cómo se fija el contexto de sesión (T03).
- Un bug en una política de RLS es un incidente de seguridad con impacto
  potencial en todos los tenants a la vez, no solo en uno. Se mitiga con
  `FORCE ROW LEVEL SECURITY` (ni siquiera el propietario de la tabla se salta
  la política) y con tests explícitos de fuga entre tenants.
- La columna `tenant.database_url` se mantiene reservada en el modelo (ver
  CLAUDE.md 4) para poder mover a un tenant concreto a su propia base de datos
  el día que un contrato lo exija, sin rediseñar el esquema.

## Alternativas descartadas

- **Base de datos por tenant** — aísla mejor pero no escala operativamente a
  cientos de miles de tenants con 3 personas de equipo; se reconsidera solo si
  un cliente lo exige por contrato (disparador ya registrado en CLAUDE.md 4).
- **Esquema por tenant** — evita duplicar bases de datos pero migrar N
  esquemas en cada release sigue sin escalar razonablemente y complica el
  pooling de conexiones (relevante para T03/PgBouncer).
