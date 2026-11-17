import { or, sql, type SQL, type AnyColumn } from "drizzle-orm";
import { digitsOnly, normalizeText } from "@/lib/search";

/**
 * Búsqueda tolerante en SQL, espejo de `matchesQuery` del cliente (`src/lib/search.ts`):
 * - nombre sin acentos ni mayúsculas (`translate`, sin depender de la extensión `unaccent`,
 *   que exigiría privilegios en la BD);
 * - teléfono por DÍGITOS, para poder teclearlo como se ve ("+52 555 000…"), con mínimo 3
 *   porque un dígito suelto barrería el directorio entero.
 *
 * La comparten Contactos y la Bandeja: una sola regla en dos pantallas.
 */
const UNACCENT_FROM = "áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ";
const UNACCENT_TO = "aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC";

export function busquedaDeContacto(
  name: AnyColumn,
  phone: AnyColumn,
  q: string | null | undefined
): SQL | undefined {
  const texto = q?.trim();
  if (!texto) return undefined;
  const dígitos = digitsOnly(texto);
  // El patrón viaja normalizado igual que la columna, y con los comodines de LIKE
  // escapados para que un "%" tecleado no liste todo.
  const like = normalizeText(texto).replace(/[\\%_]/g, "\\$&");
  return or(
    sql`lower(translate(${name}, ${UNACCENT_FROM}, ${UNACCENT_TO})) like ${`%${like}%`}`,
    dígitos.length >= 3
      ? sql`regexp_replace(coalesce(${phone}, ''), '\\D', '', 'g') like ${`%${dígitos}%`}`
      : undefined
  );
}

/** Mínimo de caracteres para buscar DENTRO de los mensajes: con menos, casi todo hilo coincide y se barrería la tabla. */
export const MIN_CONTENT_CHARS = 3;

/**
 * Coincidencia con el TEXTO de algún mensaje de la conversación (misma normalización que el nombre: sin
 * acentos ni mayúsculas, comodines de LIKE escapados). `EXISTS` y no JOIN: un hilo con diez mensajes que
 * coinciden cuenta UNA vez, y la lista conserva su paginación por cursor sin `DISTINCT`.
 */
export function busquedaEnMensajes(conversationId: AnyColumn | SQL, q: string | null | undefined): SQL | undefined {
  const texto = q?.trim();
  if (!texto || texto.length < MIN_CONTENT_CHARS) return undefined;
  const like = normalizeText(texto).replace(/[\\%_]/g, "\\$&");
  return sql`exists (
    select 1 from message m
    where m.conversation_id = ${conversationId}
      and lower(translate(m.text, ${UNACCENT_FROM}, ${UNACCENT_TO})) like ${`%${like}%`}
  )`;
}
