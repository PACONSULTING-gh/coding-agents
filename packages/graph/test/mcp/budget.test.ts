import { describe, expect, it } from 'vitest'

import { fetchRankedPage, truncateToBudget } from '../../src/mcp/budget.js'

/**
 * Presupuesto de contexto (T05), puro y sin Postgres: lo que se comprueba es
 * el mecanismo de recorte, no el ranking de una consulta SQL concreta (eso ya
 * lo cubre `test/performance.test.ts` y `test/queries.test.ts`).
 */
describe('truncateToBudget', () => {
  it('si todo cabe, no trunca nada', () => {
    const items = [{ a: 1 }, { a: 2 }, { a: 3 }]
    const result = truncateToBudget(items, 1000)
    expect(result.items).toEqual(items)
    expect(result.truncated).toBe(false)
  })

  it('recorta al primer prefijo que cabe, nunca a un objeto a medias', () => {
    // Cada objeto serializado ocupa ~11-12 bytes (+1 de separador). Con un
    // presupuesto de 30 caben 2, no 3: el corte tiene que caer en un limite de
    // objeto, jamas en mitad del JSON de uno.
    const items = [{ v: 'aaaaaaaa' }, { v: 'bbbbbbbb' }, { v: 'cccccccc' }]
    const result = truncateToBudget(items, 30)
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items.length).toBeLessThan(items.length)
    expect(result.truncated).toBe(true)
    // Cada elemento conservado tiene que poder volver a parsearse ENTERO.
    for (const item of result.items) {
      expect(() => JSON.stringify(item)).not.toThrow()
    }
    expect(result.items).toEqual(items.slice(0, result.items.length))
  })

  it('si ni el primer elemento cabe, devuelve vacio (no "no hay nada": truncated:true lo distingue)', () => {
    const result = truncateToBudget([{ v: 'x'.repeat(100) }], 10)
    expect(result.items).toEqual([])
    expect(result.truncated).toBe(true)
  })

  it('lista vacia de entrada: vacio y NO truncado (eso si es "no hay nada")', () => {
    const result = truncateToBudget([], 1000)
    expect(result.items).toEqual([])
    expect(result.truncated).toBe(false)
  })
})

describe('fetchRankedPage', () => {
  it('preserva el orden de entrada: NO reordena (el ranking ya lo decidio la consulta)', async () => {
    // A proposito en un orden que ni es alfabetico ni es el de insercion
    // "natural": si esta funcion reordenara por cualquier criterio propio
    // (clave, valor...), este test lo detectaria.
    const rows = [
      { id: 'zeta', weight: 9 },
      { id: 'alpha', weight: 1 },
      { id: 'mid', weight: 5 },
    ]
    const page = await fetchRankedPage({
      fetchLimit: 10,
      fetch: (limit) =>
        Promise.resolve({ hits: rows.slice(0, limit), truncated: rows.length > limit }),
      toOutput: (row: (typeof rows)[number]) => row,
    })
    expect(page.items.map((r) => r.id)).toEqual(['zeta', 'alpha', 'mid'])
    expect(page.truncated).toBe(false)
    expect(page.total).toBe(3)
    expect(page.totalAtLeast).toBeUndefined()
  })

  it('contador honesto: si el motor corto, total es null y totalAtLeast es la cota que SE CONOCE', async () => {
    const fetchLimit = 5
    // La capa de consulta (T01) pide `limit + 1` filas y recorta ella misma, asi
    // que aqui llegan `fetchLimit` filas Y un `truncated: true` que significa
    // "habia al menos una mas". La cota inferior honesta es fetchLimit + 1, no
    // fetchLimit: publicar fetchLimit seria quedarse una unidad por debajo de lo
    // que de verdad se sabe.
    const rows = Array.from({ length: fetchLimit }, (_, i) => ({ id: `n${String(i)}` }))
    const page = await fetchRankedPage({
      fetchLimit,
      fetch: (limit) => {
        expect(limit).toBe(fetchLimit)
        return Promise.resolve({ hits: rows, truncated: true })
      },
      toOutput: (row: { id: string }) => row,
    })
    expect(page.items).toHaveLength(fetchLimit)
    expect(page.total).toBeNull()
    expect(page.totalAtLeast).toBe(fetchLimit + 1)
    expect(page.truncated).toBe(true)
  })

  it('si el motor devuelve exactamente lo que hay, el total es exacto (no null)', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }]
    const page = await fetchRankedPage({
      fetchLimit: 10,
      fetch: (limit) =>
        Promise.resolve({ hits: rows.slice(0, limit), truncated: rows.length > limit }),
      toOutput: (row: { id: string }) => row,
    })
    expect(page.total).toBe(2)
    expect(page.truncated).toBe(false)
  })

  it('un grafo grande a proposito: la respuesta se mantiene bajo el presupuesto de bytes', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      path: `src/muy/anidado/paquete/modulo-${String(i)}/archivo-representativo.ts`,
      distance: 1 + (i % 5),
      weight: 1,
    }))
    const page = await fetchRankedPage({
      fetchLimit: 5000,
      fetch: (limit) =>
        Promise.resolve({ hits: rows.slice(0, limit), truncated: rows.length > limit }),
      toOutput: (row: (typeof rows)[number]) => row,
      maxBytes: 8 * 1024,
    })
    const bytes = new TextEncoder().encode(JSON.stringify(page.items)).length
    expect(bytes).toBeLessThanOrEqual(8 * 1024)
    expect(page.shown).toBeLessThan(rows.length)
    expect(page.truncated).toBe(true)
    // El contador sigue siendo honesto: se SABE que hay 5000 en total (el
    // motor no corto, `fetchLimit` cubria todo), solo el presupuesto de bytes
    // recorto la lista mostrada.
    expect(page.total).toBe(5000)
  })
})
