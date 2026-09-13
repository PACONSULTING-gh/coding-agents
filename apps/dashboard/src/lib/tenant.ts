/**
 * De que tenant es este panel.
 *
 * Viene del ENTORNO y no de la URL a proposito. Un panel que acepta el tenant
 * por parametro es un panel en el que cambiar un uuid en la barra de direcciones
 * enseña los datos de otro cliente — y este panel NO tiene autenticacion
 * todavia, asi que esa puerta estaria abierta de par en par.
 *
 * Cuando haya login, el tenant saldra de la sesion y esto desaparece.
 */
export function tenantId(): string {
  const value = process.env['TENANT_ID']
  if (value === undefined || value.trim() === '') {
    throw new Error(
      'Falta TENANT_ID. El panel lee datos de un cliente concreto, y sin saber cual no puede ' +
        'enseñar nada: una lista vacia se leeria como "no hay nada", que es distinto.',
    )
  }
  return value.trim()
}
