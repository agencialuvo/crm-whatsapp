/** 048 — Claves de objeto por organización: puras y validadas (un segmento raro jamás llega a la clave). */

function seg(s: string): string {
  if (!/^[\w.-]+$/.test(s)) throw new Error(`segmento de clave inválido: ${s}`);
  return s;
}

/** Lo confirmado y listo. */
export function claveDeMedio(organizationId: string, id: string): string {
  return `org/${seg(organizationId)}/medios/${seg(id)}`;
}

/** Lo recién firmado y aún sin confirmar: una regla de ciclo de vida del bucket puede borrar `pending/`. */
export function clavePendiente(organizationId: string, id: string): string {
  return `pending/${seg(organizationId)}/${seg(id)}`;
}
