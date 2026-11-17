import { z } from "zod";

/**
 * 044 — El cursor de una columna del tablero. Paginación por *keyset* sobre `(position, id)`, el mismo
 * orden estable con el que se muestra la columna. Opaco para el cliente (base64url de JSON) y validado
 * al volver: uno manipulado responde 422 y jamás llega a la consulta. `position` puede ser negativa
 * (un lead nuevo entra arriba con `min − 1`, sin renumerar la columna).
 */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const schema = z.object({ p: z.number().int().min(-2_000_000_000).max(2_000_000_000), id: z.string().regex(ID) });

export type ColumnCursor = z.infer<typeof schema>;

export const encodeColumnCursor = (c: ColumnCursor): string =>
  Buffer.from(JSON.stringify(c), "utf8").toString("base64url");

export function decodeColumnCursor(raw: string): ColumnCursor | null {
  if (raw.length > 200) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
