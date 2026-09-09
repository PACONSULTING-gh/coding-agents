# ADR 0007 — El Postgres de los tests de integración se provisiona fuera del proceso de test

**Estado:** Propuesta

**Contexto de origen:** issue #26, abierto desde el epic 05 / T03 (issue #23) al
descubrir que el gate de mutation testing estaba en verde escondiendo mutantes
vivos. Afecta a `packages/db`, `packages/queue` y `packages/graph`.

## Contexto

Hoy cada fichero de test de integración levanta su propio Postgres con
testcontainers en un `beforeAll`. Para `pnpm test` eso cuesta unos segundos y
nadie lo nota. Para el **mutation testing** cuesta **un contenedor por mutante**,
porque Stryker vuelve a ejecutar los tests una vez por cada mutante que genera.

Y eso no es solo lento: **falsea la medida**. Stryker cuenta un _timeout_ como
mutante muerto, así que cuanto más se ahoga la máquina, mejor nota saca el gate.
Medido sobre el mismo commit el 9 de septiembre de 2026, cambiando **solo**
`--concurrency`:

| Módulo                                | Concurrencia por defecto (28 núcleos)          | `--concurrency 8`                           |
| ------------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| `packages/db/src/client.ts`           | 90,34 % — **0 muertos**, 131 timeouts, 0 vivos | 77,93 % — 55 muertos, **18 supervivientes** |
| `packages/queue/src/pg-boss-queue.ts` | 76,47 % — 2 muertos, 180 timeouts, 0 vivos     | 43,70 % — 88 muertos, **78 supervivientes** |
| `packages/queue/src/envelope.ts`      | 100,00 % — 19 muertos, 27 timeouts             | 93,48 % (y 86,96 % con `--concurrency 4`)   |

El gate estaba en verde **escondiendo 96 mutantes vivos**. `packages/graph` lleva
fuera de la lista `mutate` desde el epic 02 por exactamente lo mismo: 291
mutantes, 230 estáticos, **0 muertos**, 229 timeouts y una puntuación de 78,69
que superaba el `break=60` sin que ningún test matara nada.

Durante una pasada se llegaron a contar **28 contenedores de Postgres vivos a la
vez**, con uno nuevo cada pocos segundos.

### Lo que ya se probó y NO funciona

Memoizar el contenedor a nivel de módulo (un solo servidor por paquete, una base
de datos por fichero de test, `isolate: false` en el `vitest.config.ts` del
paquete) para que la memoización cruce entre ficheros.

- Para `pnpm test` **sí** funciona: de 2 contenedores a 1, y de 26 s a 20 s.
- Para Stryker **no cambia nada**: contando contenedores durante la pasada,
  `1 → 5 → 9 → 13 → 17 → 22 → 26 → 31` en dos minutos, uno por mutante.

El registro de módulos no sobrevive entre ejecuciones de mutante, así que la
memoización se rehace cada vez. (`@stryker-mutator/vitest-runner` crea el
contexto de Vitest una sola vez en `init()` y fuerza `pool: 'threads'` con
`maxWorkers: 1`; su `resetContext()` solo limpia `state.filesMap`. El mecanismo
exacto por el que se pierde la caché de módulos no está verificado — el efecto
sí está medido.) Peor: sin el `afterAll` que paraba el contenedor, se acumulan
durante la pasada. **Se revirtió entero.**

La conclusión es que hace falta un Postgres que **sobreviva al proceso de test**,
y eso ya no es un ajuste de configuración: cambia cómo adquieren infraestructura
todos los tests de integración del repo, toca el workflow de CI y toca el
onboarding. Por eso va por ADR.

## Decisión

**Los tests de integración reciben la URL de un Postgres ya en marcha por
variable de entorno (`TEST_DATABASE_URL`), y dejan de levantarlo ellos.** Lo
provisiona `infra/docker-compose.yml` en local —el mismo fichero que ya existe y
que el test de PgBouncer ya lee— y un bloque `services:` en el workflow de CI.

Cada fichero de test **crea su propia base de datos** dentro de ese servidor y la
borra al terminar. El aislamiento pasa de ser por contenedor a ser por base de
datos, que es donde de verdad hace falta.

**Una excepción, explícita:** `packages/db/test/pgbouncer.test.ts` sigue con
testcontainers. Ese test pone un PgBouncer **delante** del Postgres sobre una red
de Docker para verificar el modo transacción, y eso necesita controlar la
topología, no solo tener una URL. Es un único fichero, no está en la lista
`mutate`, y su coste es un contenedor por ejecución de la suite, no por mutante.

## Consecuencias

**Lo que se gana:**

- La puntuación de mutation testing pasa a medir lo que dice medir. `client.ts`,
  `pg-boss-queue.ts` y los módulos de `packages/graph` pueden volver a la lista
  `mutate`, y los ~96 supervivientes reales dejan de estar escondidos.
- Deja de hacer falta `concurrency: 4` fijada en `stryker.config.json`, que hoy
  está ahí solo para que la cifra sea comparable entre máquinas.
- La suite entera es más rápida para todo el mundo, no solo bajo Stryker.

**Lo que se sacrifica, y es lo importante de este ADR:**

- **`pnpm test` deja de funcionar sobre un checkout limpio sin nada arrancado.**
  Hoy funciona; con esto hay que hacer `docker compose up -d` antes. Es una
  regresión real en la experiencia de desarrollo y es el precio principal. Se
  mitiga fallando en voz alta: si `TEST_DATABASE_URL` no está o no responde, el
  mensaje tiene que decir literalmente qué comando ejecutar, no un
  `ECONNREFUSED` pelado.
- **Los roles son del servidor, no de la base.** `app_migrator`, `app_runtime` y
  el rol de mínimo privilegio de `install.test.ts` se crean hoy dentro de un
  contenedor recién hecho. Sobre un servidor compartido hay que nombrarlos por
  ejecución, o el segundo arranque muere con `role already exists`. Esto ya se
  comprobó en el intento revertido.
- **Un servidor sucio puede hacer que un test pase o falle por razones ajenas al
  código.** La base por fichero, creada y borrada, es lo que lo contiene; hay que
  vigilar que nadie escriba en la base por defecto.

**Lo que hay que vigilar:** que las bases de datos huérfanas no se acumulen si un
test muere sin borrar la suya. Un barrido de las que empiecen por el prefijo
convenido, al arrancar la suite, es más fiable que confiar en el `afterAll`.

## Alternativas descartadas

- **`withReuse()` de testcontainers.** Marca el contenedor como reutilizable por
  hash y el reaper no lo recoge, así que el siguiente proceso lo encuentra.
  Resuelve el problema técnico y es menos invasivo. Se descarta por dos razones:
  requiere `TESTCONTAINERS_REUSE_ENABLE=true` en el entorno de cada máquina —una
  variable que si falta degrada el comportamiento **en silencio**, volviendo a un
  contenedor por mutante sin que nadie se entere— y deja un contenedor vivo en la
  máquina del desarrollador indefinidamente. Además, varios trabajadores de
  Stryker compartiendo un contenedor necesitan una base de datos por trabajador
  igualmente: el trabajo de aislamiento por base hay que hacerlo en las dos
  opciones, así que la que además elimina testcontainers del camino caliente sale
  ganando.

- **Dejarlo como está y aceptar que esos módulos no se miden.** Es lo que hay hoy
  y es defendible a corto plazo: están fuera de la lista `mutate` con el porqué
  escrito. Se descarta porque son justo los módulos con las decisiones que este
  producto no se puede permitir que se debiliten —el contexto de tenant en
  `client.ts`, el enrutado a la cola de fallidos en `pg-boss-queue.ts`— y porque
  los 96 supervivientes ya medidos no son hipotéticos.

- **Sustituir Postgres por un doble en los tests de estos módulos.** Descartado
  de plano: lo que comprueban es comportamiento del motor (RLS forzada,
  exactly-once bajo concurrencia, el modo transacción de PgBouncer). Con un doble
  solo se comprobaría que el doble hace lo que le hemos dicho (`CLAUDE.md` §5).
