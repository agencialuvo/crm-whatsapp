import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { CHANNEL_ORDER } from "@/lib/channels";
import { IGNORED_LIMIT, parseIgnoredInput } from "@/lib/ignored-number";
import {
  addIgnored,
  addIgnoredMany,
  contactIdentityById,
  countIgnored,
  findIgnoredForContact,
  listIgnored,
  type IgnoredNumberRow,
} from "@/server/ai/ignored";

export const dynamic = "force-dynamic";

/**
 * Agente → Números ignorados: las personas a las que el agente (el incluido y el cerebro externo) no contesta.
 * El mensaje sigue entrando a la Bandeja; solo se calla a la IA. La lista es la fuente de verdad: no toca la pausa
 * del contacto ni la de la conversación.
 */

/** Cómo viaja una entrada: el número con «+» para WhatsApp, y la identidad cruda en los demás canales. */
function serialize(row: IgnoredNumberRow) {
  const phone = row.channel === "whatsapp" && /^\d+$/.test(row.key);
  return {
    id: row.id,
    channel: row.channel,
    key: row.key,
    display: phone ? `+${row.key}` : row.key,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
  };
}

const channelSchema = z.enum(CHANNEL_ORDER as [string, ...string[]]);

/**
 * Leer la lista la puede hacer cualquiera del equipo: la Bandeja necesita saber qué número está ignorado.
 *
 * Con `?contactId=` responde solo por ese contacto: `{ ignored, entry }` (`entry` trae el id para quitarlo).
 */
export const GET = withAuth(async (session, req: Request) => {
  const url = new URL(req.url);
  const contactId = url.searchParams.get("contactId");
  if (contactId) {
    const contact = await contactIdentityById(session.organizationId, contactId);
    if (!contact) return apiError(404, "not_found", "Contacto no encontrado");
    const entry = await findIgnoredForContact(session.organizationId, contact);
    return Response.json({ ignored: entry !== null, entry: entry ? serialize(entry) : null });
  }
  const channel = channelSchema.safeParse(url.searchParams.get("channel") ?? undefined);
  const search = url.searchParams.get("search") ?? undefined;
  const [entries, total] = await Promise.all([
    listIgnored(session.organizationId, {
      channel: channel.success ? (channel.data as (typeof CHANNEL_ORDER)[number]) : undefined,
      search,
    }),
    countIgnored(session.organizationId),
  ]);
  return Response.json({ entries: entries.map(serialize), total, limit: IGNORED_LIMIT });
});

/** Tope del texto pegado: 500 números con nota caben de sobra. */
const MAX_BULK_CHARS = 60_000;

/**
 * Tres formas de agregar, exactamente una por petición:
 *  - `number`: un número escrito (con código de país), con nota opcional en `label`;
 *  - `contactId`: un contacto de la Bandeja (cualquier canal), con nota opcional;
 *  - `bulk`: texto pegado, un número por línea (con nota tras coma, `;` o `|`).
 */
const postSchema = z
  .object({
    number: z.string().trim().min(1).max(40).optional(),
    contactId: z.string().trim().min(1).max(100).optional(),
    bulk: z.string().max(MAX_BULK_CHARS).optional(),
    label: z.string().max(500).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const given = [v.number, v.contactId, v.bulk].filter((x) => x !== undefined).length;
    if (given !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Manda exactamente uno: number, contactId o bulk.",
      });
    }
  });

export const POST = withAuth(async (session, req: Request) => {
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo el dueño o un administrador puede hacer esto");
  }
  const body = await parseBody(req, postSchema);
  if (!body.ok) return body.response;
  const { organizationId, userId } = session;
  const { number, contactId, bulk, label } = body.data;

  // Pegar varios: el resultado es un resumen, no un error. Una línea mala no tumba las buenas.
  if (bulk !== undefined) {
    const parsed = parseIgnoredInput(bulk);
    const result = await addIgnoredMany(organizationId, parsed.valid, userId);
    return Response.json({
      added: result.added.map(serialize),
      duplicates: result.duplicates,
      invalid: parsed.invalid,
      overLimit: result.overLimit,
      limit: IGNORED_LIMIT,
    });
  }

  let outcome;
  if (contactId !== undefined) {
    const contact = await contactIdentityById(organizationId, contactId);
    if (!contact) return apiError(404, "not_found", "Contacto no encontrado");
    outcome = await addIgnored(organizationId, { contact, label }, userId);
  } else {
    outcome = await addIgnored(organizationId, { raw: number!, label }, userId);
  }

  switch (outcome.status) {
    case "added":
      return Response.json({ entry: serialize(outcome.entry) }, { status: 201 });
    case "duplicate":
      return apiError(409, "duplicate", "Ese número ya está en la lista.");
    case "limit":
      return apiError(
        409,
        "limit_reached",
        `Llegaste al tope de ${outcome.limit} números ignorados. Quita alguno para agregar más.`,
        { limit: outcome.limit }
      );
    case "invalid":
      return apiError(422, "invalid_number", outcome.error);
  }
});
