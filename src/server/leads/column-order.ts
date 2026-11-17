import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { placeAt } from "@/lib/pipeline-state";

/**
 * 044 — El orden de las columnas del tablero.
 *
 * `lead.position` ya no lo calcula el cliente: toda renumeración ocurre aquí, DENTRO de la transacción
 * de `moveLeadToStage` y con las filas de etapa bloqueadas, así que dos movimientos simultáneos a una
 * misma columna nunca la dejan con empates ni huecos. Estas funciones escriben `position` y NUNCA
 * `stage_id` (esa es la única puerta de la bitácora, ver `stage-history.ts`).
 */

export type Tx = Pick<PostgresJsDatabase<typeof schema>, "select" | "execute" | "update">;

/** Una posición más allá de cualquier columna real: «al final». Se acota al tamaño de la columna. */
export const AL_FINAL = 1_000_000_000;

export { placeAt };

/**
 * Serializa TODOS los movimientos de leads de una organización (candado de aviso de Postgres, ligado a la
 * transacción: se suelta solo al terminar). Es lo primero que hace la puerta, antes de bloquear ninguna fila.
 *
 * ¿Por qué no bloquear las filas de etapa? Porque la renumeración reescribe las filas de OTROS leads, y
 * esos pueden estar bloqueados por otra transacción que a su vez espera la etapa: interbloqueo (lo cazó la
 * prueba de 30 movimientos simultáneos). Con un solo candado tomado primero, el orden es único y no hay ciclo.
 * Los movimientos duran milisegundos; un negocio no mueve miles de tarjetas por segundo.
 */
export async function lockPipeline(tx: Tx, organizationId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pipeline:${organizationId}`}, 0))`);
}

/** Los ids de una columna en su orden de pantalla `(position, id)`, sin `exceptId`. */
export async function columnOrder(
  tx: Tx,
  organizationId: string,
  stageId: string,
  exceptId?: string
): Promise<string[]> {
  const rows = await tx
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        and(eq(schema.lead.stageId, stageId), exceptId ? ne(schema.lead.id, exceptId) : undefined)
      )
    )
    .orderBy(asc(schema.lead.position), asc(schema.lead.id));
  return rows.map((r) => r.id);
}

/** La posición más baja de una columna menos uno (entra «arriba» sin renumerar nada). 0 si está vacía. */
export async function topPosition(tx: Tx, organizationId: string, stageId: string, exceptId?: string): Promise<number> {
  const rows = await tx
    .select({ min: sql<number | null>`min(${schema.lead.position})` })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        and(eq(schema.lead.stageId, stageId), exceptId ? ne(schema.lead.id, exceptId) : undefined)
      )
    );
  const min = rows[0]?.min;
  return min === null || min === undefined ? 0 : Number(min) - 1;
}

/**
 * Escribe `position = índice` para el orden dado, SOLO en las filas cuya posición cambia (mover un lead
 * dentro de una columna reescribe el tramo afectado, no la columna entera). Devuelve cuántas filas cambió.
 */
export async function renumberColumn(tx: Tx, organizationId: string, order: readonly string[]): Promise<number> {
  if (order.length === 0) return 0;
  const payload = JSON.stringify(order.map((id, pos) => ({ id, pos })));
  const res = await tx.execute(sql`
    update lead l set position = v.pos
    from jsonb_to_recordset(${payload}::jsonb) as v(id text, pos int)
    where l.id = v.id and l.organization_id = ${organizationId} and l.position is distinct from v.pos`);
  return (res as unknown as { count?: number }).count ?? 0;
}
