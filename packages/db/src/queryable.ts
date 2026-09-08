/**
 * Minimo comun denominador de "algo contra lo que se puede consultar": un
 * `pg.Client`, un `pg.Pool` o el cliente con contexto de tenant que construye
 * T03 lo cumplen sin adaptador.
 *
 * Se declara aqui, y no se importa el tipo de `pg`, para que este paquete no
 * quede atado a una version concreta del driver y para que T02 y T03 puedan
 * avanzar en paralelo sin pisarse.
 */
export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>
}
