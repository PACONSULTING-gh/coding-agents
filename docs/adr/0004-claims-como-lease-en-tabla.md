# ADR 0004 — Los claims son un lease en tabla, no un advisory lock con TTL

**Estado:** Aceptada

**Contexto de origen:** epic 02, T04 (issue #15). Este ADR **corrige el enunciado
técnico de esa tarea**, que tal y como está escrito no se puede implementar.

## Contexto

La tarea T04 del epic 02 (`.claude/epics/epic-02-grafo-colisiones.md`) dice
literalmente:

> Advisory locks de Postgres, **transaccionales y con TTL**. Un claim reserva un
> issue y opcionalmente un conjunto de ficheros. Los claims caducan solos si el
> agente muere.

Esas tres propiedades —advisory lock, transaccional, con TTL— **no pueden darse
a la vez**. Postgres ofrece dos familias de advisory locks y ninguna sirve:

1. **`pg_advisory_xact_lock` (transaccional).** Postgres lo suelta solo en el
   `COMMIT` o el `ROLLBACK`. Un claim tiene que sobrevivir minutos u horas
   mientras un agente trabaja; sostenerlo con un lock transaccional obligaría a
   mantener una transacción abierta todo ese tiempo, reteniendo una conexión del
   pool y bloqueando el `VACUUM`. Y sigue sin haber TTL: un lock no caduca, se
   suelta.

2. **`pg_advisory_lock` (de sesión).** Sí persiste entre transacciones, pero
   **no funciona en nuestro despliegue**. Corremos detrás de **PgBouncer en modo
   transacción**, que es decisión cerrada (CLAUDE.md §3, ADR 0001): en ese modo
   una conexión lógica de cliente no está atada a un backend físico. El lock se
   tomaría en un backend cualquiera, PgBouncer lo devolvería al pool en cuanto
   acabara la transacción, y el lock quedaría **pegado a un backend que después
   sirve a otro cliente, de otro tenant**. Es exactamente el mismo fallo por el
   que la capa de acceso a datos usa `set_config('app.tenant_id', $1, true)` y
   no un `SET` de sesión — está explicado largo en la cabecera de
   `packages/db/src/client.ts`. Tampoco tendría TTL: si el agente muere sin
   cerrar la sesión, el lock se queda hasta que el backend se recicle.

Además, un lock —de la familia que sea— **no sabe decir de quién es**. Un
criterio de aceptación de T04 exige avisar de **quién** tiene el fichero y
**desde cuándo**; `pg_locks` sólo guarda un entero de 64 bits.

Un cuarto criterio pide que, con muchos claims activos, `pg_locks` no agote la
memoria compartida. La tabla de locks de Postgres es de tamaño fijo
(`max_locks_per_transaction × (max_connections + max_prepared_transactions)`):
una implementación basada en locks de sesión persistentes tiene un techo duro de
claims simultáneos y, al tocarlo, **falla el sistema entero**, no sólo el que
reclama.

## Decisión

**La fuente de verdad de un claim es una fila de la tabla `claims` (migración
`0008`), con `expires_at` como arriendo.** Un claim está vivo si y sólo si:

```sql
released_at IS NULL AND expires_at > now()
```

**`pg_advisory_xact_lock` se conserva, pero con otro papel:** serializar la
operación de reclamar (segar caducados → comprobar → insertar) **dentro de una
única transacción**, con el grano `(tenant_id, repo_id)`. Al ser transaccional,
se suelta en el `COMMIT`, así que **entre transacciones no queda ningún advisory
lock retenido** y no hay presión sobre la memoria compartida.

La unicidad "un solo claim vivo por sujeto" la respalda además un **índice único
parcial** del motor:

```sql
UNIQUE (tenant_id, repo_id, subject_kind, subject_key) WHERE released_at IS NULL
```

El predicado de un índice parcial tiene que ser **inmutable**, así que no puede
llevar `expires_at > now()`. Se resuelve **materializando la caducidad**: la
propia operación de reclamar, ya dentro del advisory lock, marca
`released_at = now(), released_reason = 'expired'` en los claims del sujeto que
ya vencieron, y sólo después inserta. Ese segado es un paso **en línea** de la
transacción, no un proceso de fondo.

## Consecuencias

**Se gana:**

- Los claims caducan solos y **la corrección no depende de que corra ninguna
  purga**: aunque nadie siegue nada, un claim vencido deja de contar porque toda
  lectura filtra por `expires_at > now()`.
- El rechazo puede decir **quién** lo tiene y **desde cuándo** (`holder_label`,
  `claimed_at`), que es el criterio de aceptación. Un lock no puede.
- No hay estado de sesión, así que funciona bajo PgBouncer en modo transacción
  sin excepciones ni un pool aparte.
- Los claims quedan **auditables e inspeccionables con SQL normal**: la "vista de
  claims activos" es un `SELECT`, no una lectura de `pg_locks`.
- El número de claims simultáneos lo limita el disco, no
  `max_locks_per_transaction`.

**Se sacrifica / hay que vigilar:**

- El advisory lock es **por repositorio**, no por sujeto: dos reclamaciones de
  sujetos distintos del mismo repo se serializan. Reclamar no es una operación
  de alta frecuencia (unas pocas por persona y hora), pero si algún día se mide
  contención, bajar el grano es un cambio local a `lockRepository()` — y exigirá
  tomar los locks en orden global para no provocar interbloqueos.
- Un claim vencido y no segado **sigue ocupando el índice único parcial** hasta
  que alguien vuelva a reclamar ese sujeto. Es correcto (nadie lo ve como vivo),
  pero significa que el índice contiene más entradas que claims vivos.
- La tabla crece. Por eso existe la purga periódica sobre el `QueuePort`
  (`claims.purge`), que **sólo recorta el histórico**: si deja de correr, el
  sistema sigue siendo correcto.
- El reloj es el **del servidor de base de datos** (`now()`), no el de la máquina
  del agente. Es deliberado: los portátiles de los desarrolladores tienen relojes
  que se van, y un TTL medido contra un reloj que se va no es un TTL.

## Alternativas descartadas

- **`pg_advisory_lock` de sesión** — no funciona bajo PgBouncer en modo
  transacción (el lock se queda pegado en un backend que luego sirve a otro
  tenant), no tiene TTL, no sabe decir de quién es, y tiene un techo duro de
  memoria compartida. Descartada por el motivo 2 del contexto.
- **`pg_advisory_xact_lock` sosteniendo el claim entero** — obligaría a mantener
  una transacción abierta durante toda la vida del claim. Descartada: retiene una
  conexión del pool por agente y bloquea el `VACUUM`.
- **`SELECT ... FOR UPDATE` sobre una fila de "sujeto"** — exigiría una tabla de
  sujetos preexistente (una fila por issue y por fichero del repo, creada antes
  de poder reclamar nada) y sigue siendo un lock sostenido mientras dure la
  transacción, no un arriendo. Más piezas para menos garantías.
- **Restricción de exclusión GiST sobre `tstzrange(claimed_at, expires_at)`** —
  es la formulación más precisa ("no dos claims sin liberar con ventanas de
  validez solapadas") y no necesita segado, pero exige la extensión
  `btree_gist`. Añadir una extensión al despliegue para ganar precisión sobre un
  caso que el segado ya cubre no compensa hoy. **Disparador para reconsiderarla:**
  que aparezca la necesidad de reservar sujetos _en el futuro_ (agendar un claim),
  donde los rangos dejan de solaparse trivialmente y el segado ya no basta.
- **Redis / un servicio de locks distribuido** — está en la tabla de "lo que NO
  se construye todavía" de CLAUDE.md §4, y su disparador (miles de jobs/seg
  sostenidos) no se cumple ni de lejos.
