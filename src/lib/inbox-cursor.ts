import { z } from "zod";

/**
 * 042 — Los cursores de la bandeja.
 *
 * Son paginación por *keyset*: la última fila vista, no un número de página. La llave de tiempo viaja
 * como TEXTO de Postgres (`2026-11-17 10:00:00.123456`), con sus microsegundos: pasarla por un `Date`
 * de JavaScript (milisegundos) haría que dos filas con el mismo milisegundo se repitieran o se saltaran
 * entre una página y otra.
 *
 * Son opacos para el cliente (base64url de JSON) y se validan al volver: un cursor manipulado responde
 * 422, jamás llega a la consulta.
 */

const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const listSchema = z.object({ k: z.string().regex(TIMESTAMP), id: z.string().regex(ID) });
const threadSchema = z.object({
  t: z.string().regex(TIMESTAMP),
  c: z.string().regex(TIMESTAMP),
  id: z.string().regex(ID),
});

export type ListCursor = z.infer<typeof listSchema>;
export type ThreadCursor = z.infer<typeof threadSchema>;

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode<T>(raw: string, schema: z.ZodType<T>): T | null {
  if (raw.length > 400) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const parsed = schema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const encodeListCursor = (c: ListCursor): string => encode(c);
export const decodeListCursor = (raw: string): ListCursor | null => decode(raw, listSchema);
export const encodeThreadCursor = (c: ThreadCursor): string => encode(c);
export const decodeThreadCursor = (raw: string): ThreadCursor | null => decode(raw, threadSchema);
