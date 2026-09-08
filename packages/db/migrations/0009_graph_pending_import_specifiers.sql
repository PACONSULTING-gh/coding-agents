-- Up Migration
-- ============================================================================
-- 0009 — Especificadores de import por fichero, y una correccion de
--        documentacion en `graph_edges.weight`.
--
-- ----------------------------------------------------------------------------
-- 1. graph_files.import_specifiers
-- ----------------------------------------------------------------------------
-- La ingesta incremental de T02 replanifica un fichero cuando cambia su hash de
-- contenido. Eso NO basta: la resolucion de un import depende tambien del
-- CONJUNTO DE RUTAS del repositorio, no solo del contenido del fichero que
-- importa. Dos agujeros reales, los dos reproducidos contra Postgres:
--
--   * Se borra `src/lib.ts` y despues se vuelve a anadir identico. `src/app.ts`
--     no cambio de hash, no se reparsea, y la arista
--     `app.ts --imports--> lib.ts` no vuelve NUNCA.
--   * Se anade `src/nuevo.ts`, que un `src/app.ts` intacto ya importaba. La
--     arista no llega a crearse.
--
-- En los dos casos la ingesta termina "bien" y `unresolvedImports` vale 0, asi
-- que el grafo se queda desactualizado EN SILENCIO — y todo lo que se construye
-- encima (radio de impacto, deteccion de colisiones) hereda el agujero.
--
-- Guardando por fichero los especificadores tal cual aparecen en el codigo, la
-- planificacion puede volver a resolverlos contra el conjunto de rutas NUEVO y
-- contra el ANTERIOR, y replanificar exactamente los ficheros cuya resolucion
-- cambia. Es informacion que la ingesta ya tiene en la mano al parsear: lo unico
-- que faltaba era persistirla.
--
-- `text[]` y no `jsonb`: es una lista de cadenas y nada mas. El DEFAULT vacio
-- hace que las filas escritas por la version anterior del codigo se lean sin
-- migracion de datos; se rellenan solas la primera vez que ese fichero se
-- reparsea.
-- ============================================================================
ALTER TABLE graph_files
  ADD COLUMN import_specifiers text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN graph_files.import_specifiers IS
  'Especificadores de import de este fichero, tal cual aparecen en el codigo (./x.js, pg, os). Sirven para replanificar el fichero cuando el conjunto de rutas del repo cambia y su resolucion cambia con el, aunque su contenido no haya cambiado.';

-- ----------------------------------------------------------------------------
-- 2. graph_edges.weight: el COMMENT contradecia al codigo
-- ----------------------------------------------------------------------------
-- Decia "para `cochange` es la frecuencia de co-cambio". No lo es: T03 guarda
-- ahi el LIFT (cuantas veces mas de lo esperado por azar cambian juntos esos dos
-- ficheros), y la frecuencia bruta va a `metadata.cochangeCount`. El motivo esta
-- razonado en `packages/graph/src/cochange/mine.ts` y registrado en el
-- ADR 0005; el COMMENT es lo primero que lee quien consulta la tabla y no puede
-- decir otra cosa que el codigo.
-- ----------------------------------------------------------------------------
COMMENT ON COLUMN graph_edges.weight IS
  '1.0 para las aristas estaticas y de build (o esta o no esta). Para `cochange` es el LIFT del par (co-ocurrencia observada / esperada por azar), no la frecuencia bruta: la frecuencia va en metadata.cochangeCount. Ver ADR 0005.';

-- Down Migration
ALTER TABLE graph_files DROP COLUMN IF EXISTS import_specifiers;

COMMENT ON COLUMN graph_edges.weight IS
  '1.0 para las aristas estaticas y de build (o esta o no esta). Para `cochange` es la frecuencia de co-cambio, que es lo que permite ranquear.';
