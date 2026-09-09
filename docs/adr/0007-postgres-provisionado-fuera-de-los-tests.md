# ADR 0007 — El Postgres de los tests de integración se provisiona fuera del proceso de test

**Estado:** Propuesta (implementada y medida en `packages/queue` y `packages/db`; falta `packages/graph`)

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

**Los tests de integración adquieren su Postgres según esta política, en este
orden:**

| Situación                                | Qué hace                                       |
| ---------------------------------------- | ---------------------------------------------- |
| `TEST_DATABASE_URL` definida             | Usa ese servidor                               |
| No definida                              | Levanta **un** contenedor, una vez por proceso |
| No definida **y corriendo bajo Stryker** | **Falla en voz alta. No mide.**                |

Y **cada fichero de test crea su propia base de datos** dentro del servidor que
le toque, y la borra al terminar. El aislamiento pasa de ser por contenedor a
ser por base de datos, que es donde de verdad hace falta.

La tercera fila es la que hace que esto funcione. El problema medido —una
puntuación de mutación que sale de los timeouts— **solo aparece bajo Stryker**,
y se puede detectar que estamos bajo Stryker de forma fiable: su runner de
Vitest inyecta un fichero de setup que crea `globalThis.__stryker__` en el
proceso de test. Así que no hace falta elegir entre medir bien y arrancar sin
fricción: se puede exigir el servidor externo **solo donde importa**.

En local, `infra/docker-compose.yml` —el mismo fichero que ya existe y que el
test de PgBouncer ya lee— y en CI un bloque `services:`.

**Una excepción, explícita:** `packages/db/test/pgbouncer.test.ts` sigue con
testcontainers siempre. Ese test pone un PgBouncer **delante** del Postgres sobre
una red de Docker para verificar el modo transacción, y eso necesita controlar la
topología, no solo tener una URL. Es un único fichero, no está en la lista
`mutate`, y su coste es un contenedor por ejecución de la suite, no por mutante.

## Consecuencias

**Lo que se gana:**

- La puntuación de mutation testing pasa a medir lo que dice medir. `client.ts`,
  `pg-boss-queue.ts` y los módulos de `packages/graph` pueden volver a la lista
  `mutate`, y los ~96 supervivientes reales dejan de estar escondidos.
- **No se puede volver a medir deshonestamente sin enterarse.** Es la propiedad
  que se le exigió a este ADR y que hundió a `withReuse()`: o hay servidor
  externo, o `pnpm test:mutation` se niega a correr.
- Deja de hacer falta `concurrency: 4` fijada en `stryker.config.json`, que hoy
  está ahí solo para que la cifra sea comparable entre máquinas.
- La suite es más rápida para quien levante el compose, sin obligar a nadie.

**Lo que NO se sacrifica, y en la primera versión de este ADR sí:** `pnpm test`
sigue funcionando sobre un checkout limpio sin arrancar nada. La versión anterior
daba eso por perdido y proponía `docker compose up -d` como requisito de
onboarding. Era un precio que no hacía falta pagar.

**Lo que sí se acepta:**

- **Dos caminos de adquisición en vez de uno**, y por tanto un modo en el que
  casi nadie corre a diario (el externo) que puede pudrirse sin que se note. Se
  contiene haciendo que CI use SIEMPRE el camino externo: si se rompe, se rompe
  en rojo y en cada PR, no el día que alguien mida mutación.
- **Los roles son del servidor, no de la base.** `app_migrator`, `app_runtime` y
  el rol de mínimo privilegio de `install.test.ts` se crean hoy dentro de un
  contenedor recién hecho. Sobre un servidor compartido hay que nombrarlos por
  ejecución, o el segundo arranque muere con `role already exists`. Ya
  comprobado en el intento revertido.
- **Un servidor sucio puede hacer que un test pase o falle por razones ajenas al
  código.** La base por fichero, creada y borrada, es lo que lo contiene.
- **Los tests de `packages/queue` pasan a depender del soporte de test de
  `packages/db`** para hablar SQL, porque la fitness function `pg-solo-en-db`
  reserva el driver a ese paquete y con un servidor externo ya no se puede usar
  el `psql` de dentro del contenedor. Hay precedente: `packages/agents` ya
  importa `packages/db/test/support/database.ts`.

**Lo que hay que vigilar:** que las bases de datos huérfanas no se acumulen si un
test muere sin borrar la suya. Un barrido de las que empiecen por el prefijo
convenido, al arrancar la suite, es más fiable que confiar en el `afterAll`.

## Comprobado sobre `packages/queue` y `packages/db`

Antes de escribir esta sección el ADR era una propuesta razonada. Ahora está
medido: `packages/queue` ya sigue esta política (`packages/db/test/support/postgres-server.ts`
y `packages/queue/test/postgres.ts`).

|                                  | Contenedor por mutante | Servidor externo |
| -------------------------------- | ---------------------- | ---------------- |
| Puntuación de `pg-boss-queue.ts` | **76,47 %**            | **42,86 %**      |
| Mutantes muertos                 | 2                      | **72**           |
| Timeouts                         | 180                    | 30               |
| Supervivientes                   | 0                      | **80**           |
| Duración de la pasada            | ~25 min                | **8 min 12 s**   |
| Contenedores vivos a la vez      | 28 y subiendo          | **0**            |

La puntuación **baja** porque la de antes era falsa. Los 80 supervivientes y los
56 mutantes sin cobertura ya estaban ahí; lo único que cambia es que ahora se
ven.

Y la suite normal no sufre: `pnpm test` del paquete pasa de 26 s a **24 s** con
contenedor (uno por proceso en vez de uno por fichero) y a **16,5 s** contra un
servidor externo. Los 27 tests siguen en verde.

### `packages/db`

|                           | Contenedor por mutante                 | Servidor externo               |
| ------------------------- | -------------------------------------- | ------------------------------ |
| Puntuación de `client.ts` | **90,34 %** con **0 mutantes muertos** | **68,97 %** con **94 muertos** |
| Timeouts                  | 131                                    | 6                              |
| Supervivientes            | 0                                      | 31                             |
| Duración                  | ~25 min                                | **4 min 34 s**                 |

`client.ts` **vuelve a la lista `mutate`**: 68,97 supera el `break=60`. El gate
completo queda en **86,58 %** en 6 min 52 s, y `envelope.ts` pasa a **0
timeouts** —sin contenedores no hay caducidades espurias que inflen a nadie—.

Dos cosas aparecieron al migrar `packages/db`, y ninguna estaba prevista en la
primera versión de este ADR:

1. **`tuple concurrently updated`.** Los roles son objetos de cluster: varios
   ficheros de test arrancando a la vez tocan la misma fila de `pg_authid`.
   Derivar la contraseña quita la carrera semántica —todos escriben el mismo
   valor— pero no la física. Medido: 3 de 6 ficheros caían. Se resuelve con un
   advisory lock de sesión sobre la base por defecto del servidor, tomado
   alrededor del bootstrap de roles. No contradice el ADR 0004: allí el problema
   era sostener un lock durante horas detrás de PgBouncer en modo transacción;
   esto es una sección crítica de milisegundos sobre una conexión directa.
2. **El ámbito de los advisory locks es la BASE DE DATOS**, no el cluster. Tomar
   el cerrojo en la base de test recién creada no habría excluido a nadie.

**Lo que esto deja pendiente:** 42,86 % está por debajo del `break=60`, así que
`pg-boss-queue.ts` **no vuelve todavía** a la lista `mutate`. Dejarlo entrar
pondría el workflow semanal en rojo de forma permanente, y un gate que siempre
está rojo se acaba ignorando —que es el mismo fallo, por el otro extremo—.
Entra cuando los supervivientes bajen del umbral (issue #26).

## Alternativas descartadas

- **`withReuse()` de testcontainers.** Marca el contenedor como reutilizable por
  hash y el reaper no lo recoge, así que el siguiente proceso lo encuentra.
  Resuelve el problema técnico y es menos invasivo. Se descarta porque requiere
  `TESTCONTAINERS_REUSE_ENABLE=true` en el entorno de cada máquina, y **si esa
  variable falta, degrada en silencio**: se vuelve a un contenedor por mutante y
  la puntuación vuelve a salir de los timeouts sin que nadie se entere. Para un
  problema que consiste exactamente en una medida que mentía sin avisar, ese es
  el peor modo de fallo posible. Además deja un contenedor vivo en la máquina
  indefinidamente, y varios trabajadores de Stryker compartiéndolo necesitan una
  base de datos por trabajador igualmente: el trabajo de aislamiento por base hay
  que hacerlo en las dos opciones.

- **Exigir siempre el servidor externo** (la primera versión de este ADR). Mide
  igual de bien, pero rompe `pnpm test` sobre un checkout limpio a cambio de
  nada: el problema solo existe bajo Stryker, y bajo Stryker se puede detectar.

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
