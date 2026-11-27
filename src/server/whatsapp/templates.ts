import { and, eq, sql } from "drizzle-orm";
import {
  countVariables,
  renderBody,
  templatesGoneFromMeta,
  validateBodyVariables,
} from "@/lib/templates";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { graphRequest, MetaApiError, normalizeRecipient } from "@/lib/meta/client";
import { destinatarioMeta } from "@/lib/meta/destinatario";
import { scoped } from "@/lib/db/tenant";
import {
  getCredentialsByOrg,
  getCredentialsByWabaId,
  markReconnectRequired,
} from "@/server/whatsapp/credentials";
import { callGraphSend, SendError } from "@/server/inbox/send";
import { enviarYRegistrar } from "@/server/inbox/outbox";
import { puedeEnviar } from "@/server/inbox/metering";
import type { WebhookValue } from "@/server/inbox/webhook";

/** Errores tipados del servicio de plantillas → HTTP en la capa de API. */
export class TemplateError extends Error {
  code:
    | "not_connected"
    | "reconnect_required"
    | "invalid"
    | "not_found"
    | "in_use"
    | "not_editable"
    | "meta_error"
    | "meta_unavailable";

  constructor(code: TemplateError["code"], message: string) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
  }
}

const TEMPLATE_ERROR_STATUS: Record<TemplateError["code"], number> = {
  not_connected: 409,
  reconnect_required: 409,
  invalid: 422,
  not_found: 404,
  in_use: 409,
  not_editable: 409,
  meta_error: 422,
  meta_unavailable: 503,
};

export function templateErrorStatus(err: TemplateError): number {
  return TEMPLATE_ERROR_STATUS[err.code];
}

export { countVariables, renderBody, validateBodyVariables };

type TemplateRow = typeof schema.template.$inferSelect;

export function serializeTemplate(t: TemplateRow) {
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    body: t.body,
    status: t.status,
    rejectionReason: t.rejectionReason,
  };
}

/** Crea la plantilla y la manda a aprobación de Meta (FR-050). */
export async function createTemplate(
  organizationId: string,
  input: {
    name: string;
    language: string;
    category: string;
    body: string;
    /** Un ejemplo por variable, en orden; es lo que ve quien revisa en Meta. */
    examples?: string[];
  }
): Promise<TemplateRow> {
  const variableError = validateBodyVariables(input.body);
  if (variableError) throw new TemplateError("invalid", variableError);

  const creds = await getCredentialsByOrg(organizationId);
  if (!creds) {
    throw new TemplateError("not_connected", "Conecta tu número de WhatsApp primero");
  }
  if (creds.status === "reconnect_required") {
    throw new TemplateError("reconnect_required", "Reconecta tu número antes de crear plantillas");
  }

  const name = input.name
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  if (!name) throw new TemplateError("invalid", "Nombre de plantilla inválido");

  // Meta pide un ejemplo por variable: si faltan, rechaza la plantilla. Uno
  // realista («Ana», «martes 14») ayuda a que la aprueben; si el dueño no
  // escribió alguno, va el genérico.
  const variableCount = countVariables(input.body);
  const examples = Array.from(
    { length: variableCount },
    (_, i) => input.examples?.[i]?.trim() || `ejemplo ${i + 1}`
  );
  let waTemplateId: string | null = null;
  try {
    const res = await graphRequest<{ id?: string; status?: string }>(
      `${creds.wabaId}/message_templates`,
      {
        method: "POST",
        token: creds.token,
        body: {
          name,
          language: input.language,
          category: input.category,
          components: [
            {
              type: "BODY",
              text: input.body,
              ...(variableCount > 0
                ? { example: { body_text: [examples] } }
                : {}),
            },
          ],
        },
      }
    );
    waTemplateId = res.id ?? null;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markReconnectRequired(organizationId);
        throw new TemplateError("reconnect_required", "El token expiró: reconecta el número");
      }
      if (err.status === 0 || err.status >= 500) {
        throw new TemplateError("meta_unavailable", "Meta no está disponible ahora");
      }
      throw new TemplateError("meta_error", err.message);
    }
    throw err;
  }

  const db = getDb();
  const inserted = await db
    .insert(schema.template)
    .values({
      id: newId("template"),
      organizationId,
      name,
      language: input.language,
      category: input.category,
      body: input.body,
      status: "pending",
      waTemplateId,
    })
    .onConflictDoUpdate({
      target: [
        schema.template.organizationId,
        schema.template.name,
        schema.template.language,
      ],
      set: {
        category: input.category,
        body: input.body,
        status: "pending",
        rejectionReason: null,
        waTemplateId,
        updatedAt: new Date(),
      },
    })
    .returning();
  return inserted[0]!;
}

/** Los flujos de automatización con un paso que envía esta plantilla (`config.templateId`). */
export async function flowsUsingTemplate(
  organizationId: string,
  templateId: string
): Promise<{ id: string; name: string }[]> {
  const s = schema.automationStep;
  const f = schema.automationFlow;
  return getDb()
    .selectDistinct({ id: f.id, name: f.name })
    .from(s)
    .innerJoin(f, eq(f.id, s.flowId))
    .where(
      scoped(
        s.organizationId,
        organizationId,
        sql`${s.config}->>'templateId' = ${templateId}`
      )
    );
}

/** Meta ya no la tiene (la borraron desde el Administrador de WhatsApp): basta con quitarla de aquí. */
function isAlreadyGoneInMeta(err: MetaApiError): boolean {
  if (err.status === 404) return true;
  return err.code === 100 && /not\s+(be\s+)?found|does not exist|no existe/i.test(err.message);
}

/**
 * Borra la plantilla en Meta (`DELETE {waba}/message_templates?name=…&hsm_id=…`) y luego aquí. Con `hsm_id`
 * solo se borra ESE idioma; sin él Meta borraría todos los idiomas con ese nombre. Si una automatización la
 * usa, no se borra (409 `in_use`): el paso se quedaría enviando una plantilla que ya no existe. Sin número
 * conectado solo queda la copia local, que es lo único que se puede quitar.
 */
export async function deleteTemplate(
  organizationId: string,
  templateId: string
): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.template)
    .where(
      scoped(
        schema.template.organizationId,
        organizationId,
        eq(schema.template.id, templateId)
      )
    )
    .limit(1);
  if (!row) throw new TemplateError("not_found", "Esa plantilla ya no existe");

  const flows = await flowsUsingTemplate(organizationId, templateId);
  if (flows.length > 0) {
    const names = flows.map((f) => `«${f.name}»`).join(", ");
    throw new TemplateError(
      "in_use",
      flows.length === 1
        ? `La usa la automatización ${names}. Cámbiala o quita ese paso antes de borrarla.`
        : `La usan las automatizaciones ${names}. Cámbialas o quita esos pasos antes de borrarla.`
    );
  }

  const creds = await getCredentialsByOrg(organizationId);
  if (creds && row.status !== "draft") {
    if (creds.status === "reconnect_required") {
      throw new TemplateError("reconnect_required", "Reconecta tu número antes de borrar plantillas");
    }
    const params = new URLSearchParams({ name: row.name });
    if (row.waTemplateId) params.set("hsm_id", row.waTemplateId);
    try {
      await graphRequest(`${creds.wabaId}/message_templates?${params.toString()}`, {
        method: "DELETE",
        token: creds.token,
      });
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      if (err.isAuthError) {
        await markReconnectRequired(organizationId);
        throw new TemplateError("reconnect_required", "El token expiró: reconecta el número");
      }
      if (!isAlreadyGoneInMeta(err)) {
        if (err.status === 0 || err.status >= 500) {
          throw new TemplateError("meta_unavailable", "Meta no está disponible ahora. Inténtalo en unos minutos.");
        }
        throw new TemplateError("meta_error", err.message);
      }
    }
  }

  await db
    .delete(schema.template)
    .where(
      scoped(
        schema.template.organizationId,
        organizationId,
        eq(schema.template.id, templateId)
      )
    );
}

/**
 * Edita el texto (y, si Meta lo permite, la categoría) de una plantilla con `POST /{template_id}`. El nombre y
 * el idioma no se pueden cambiar en Meta. Solo se editan plantillas aprobadas o rechazadas (una en revisión no);
 * una aprobada no cambia de categoría y Meta limita sus ediciones (1 cada 24 h, 10 al mes). Tras editarla vuelve
 * a revisión: mientras tanto no se puede enviar. Si una automatización la usa, no puede cambiar el número de
 * variables (los pasos guardan un valor por variable).
 */
export async function editTemplate(
  organizationId: string,
  templateId: string,
  input: { category: string; body: string; examples?: string[] }
): Promise<TemplateRow> {
  const variableError = validateBodyVariables(input.body);
  if (variableError) throw new TemplateError("invalid", variableError);

  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.template)
    .where(
      scoped(schema.template.organizationId, organizationId, eq(schema.template.id, templateId))
    )
    .limit(1);
  if (!row) throw new TemplateError("not_found", "Esa plantilla ya no existe");
  if (row.status === "pending") {
    throw new TemplateError(
      "not_editable",
      "Meta la está revisando: podrás editarla cuando la apruebe o la rechace"
    );
  }
  if (row.status === "approved" && input.category !== row.category) {
    throw new TemplateError(
      "invalid",
      "Meta no deja cambiar la categoría de una plantilla aprobada. Crea una nueva con la otra categoría."
    );
  }
  if (input.body === row.body && input.category === row.category) {
    throw new TemplateError("invalid", "No hay cambios que guardar");
  }

  const variableCount = countVariables(input.body);
  if (variableCount !== countVariables(row.body)) {
    const flows = await flowsUsingTemplate(organizationId, templateId);
    if (flows.length > 0) {
      const names = flows.map((f) => `«${f.name}»`).join(", ");
      throw new TemplateError(
        "in_use",
        `La usa ${flows.length === 1 ? "la automatización" : "las automatizaciones"} ${names}: no cambies cuántas variables tiene, o ajusta antes esos pasos.`
      );
    }
  }

  const creds = await getCredentialsByOrg(organizationId);
  if (!creds) {
    throw new TemplateError("not_connected", "Conecta tu número de WhatsApp primero");
  }
  if (creds.status === "reconnect_required") {
    throw new TemplateError("reconnect_required", "Reconecta tu número antes de editar plantillas");
  }
  if (!row.waTemplateId) {
    throw new TemplateError(
      "not_editable",
      "Esta plantilla no tiene su identificador de Meta. Pulsa «Actualizar estado» y vuelve a intentarlo."
    );
  }

  const examples = Array.from(
    { length: variableCount },
    (_, i) => input.examples?.[i]?.trim() || `ejemplo ${i + 1}`
  );
  try {
    await graphRequest(encodeURIComponent(row.waTemplateId), {
      method: "POST",
      token: creds.token,
      body: {
        ...(row.status === "approved" ? {} : { category: input.category }),
        components: [
          {
            type: "BODY",
            text: input.body,
            ...(variableCount > 0 ? { example: { body_text: [examples] } } : {}),
          },
        ],
      },
    });
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markReconnectRequired(organizationId);
        throw new TemplateError("reconnect_required", "El token expiró: reconecta el número");
      }
      if (err.status === 0 || err.status >= 500) {
        throw new TemplateError("meta_unavailable", "Meta no está disponible ahora. Inténtalo en unos minutos.");
      }
      throw new TemplateError("meta_error", err.message);
    }
    throw err;
  }

  const [updatedRow] = await db
    .update(schema.template)
    .set({
      body: input.body,
      category: input.category,
      status: "pending",
      rejectionReason: null,
      updatedAt: new Date(),
    })
    .where(
      scoped(schema.template.organizationId, organizationId, eq(schema.template.id, templateId))
    )
    .returning();
  return updatedRow!;
}

function mapMetaStatus(
  status: string | undefined
): TemplateRow["status"] | null {
  const s = (status ?? "").toUpperCase();
  if (s === "APPROVED") return "approved";
  if (s === "REJECTED") return "rejected";
  if (s === "PENDING" || s === "IN_APPEAL" || s === "PENDING_DELETION") {
    return "pending";
  }
  return null;
}

type RemoteTemplate = {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  rejected_reason?: string;
  components?: { type?: string; text?: string }[];
};

/** Tope de páginas por sincronización (100 por página): si se alcanza, la lista NO está completa. */
const SYNC_MAX_PAGES = 50;
const GONE_IN_META_REASON = "Ya no existe en Meta: la borraron desde el Administrador de WhatsApp";

/**
 * Lee TODAS las plantillas de la WABA siguiendo el cursor `paging.cursors.after` (Meta da 25 por defecto: sin
 * esto, de la plantilla 26 en adelante nunca se sincronizaban). `complete` = se leyó hasta el final.
 */
async function listRemoteTemplates(
  wabaId: string,
  token: string
): Promise<{ templates: RemoteTemplate[]; complete: boolean }> {
  const templates: RemoteTemplate[] = [];
  let after: string | null = null;
  for (let page = 0; page < SYNC_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      limit: "100",
      fields: "id,name,language,status,category,rejected_reason,components",
    });
    if (after) params.set("after", after);
    const res: {
      data?: RemoteTemplate[];
      paging?: { cursors?: { after?: string }; next?: string };
    } = await graphRequest(`${wabaId}/message_templates?${params.toString()}`, { token });
    const data = res.data ?? [];
    templates.push(...data);
    const next = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (!next || data.length === 0) return { templates, complete: true };
    after = next;
  }
  return { templates, complete: false };
}

/**
 * Sincroniza desde Graph (`GET {waba}/message_templates`, todas las páginas). Cubre el modo agencia: los
 * webhooks de plantillas NO siguen el override de callback, así que el pull es la vía universal
 * (DV-VC-04/DV-VC-15). Meta es la autoridad en estado, categoría y texto (pudo editarse en su panel). Una
 * plantilla que ya no está en Meta se quita de aquí; si una automatización la usa, se conserva marcada como
 * rechazada con el motivo (el flujo no puede enviarla y el dueño ve por qué).
 */
export async function syncTemplates(
  organizationId: string
): Promise<{ updated: number; removed: number }> {
  const creds = await getCredentialsByOrg(organizationId);
  if (!creds) {
    throw new TemplateError("not_connected", "Conecta tu número de WhatsApp primero");
  }

  let listing: { templates: RemoteTemplate[]; complete: boolean };
  try {
    listing = await listRemoteTemplates(creds.wabaId, creds.token);
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markReconnectRequired(organizationId);
        throw new TemplateError("reconnect_required", "El token expiró: reconecta el número");
      }
      throw new TemplateError("meta_unavailable", "No se pudo consultar Meta");
    }
    throw err;
  }

  const db = getDb();
  const local = await db
    .select()
    .from(schema.template)
    .where(scoped(schema.template.organizationId, organizationId));

  const seen = new Set<string>();
  let updated = 0;
  for (const remote of listing.templates) {
    const match = local.find(
      (t) =>
        (remote.id && t.waTemplateId === remote.id) ||
        (t.name === remote.name && t.language === remote.language)
    );
    if (!match) continue;
    if ((remote.status ?? "").toUpperCase() === "DELETED") continue; // cuenta como ausente
    seen.add(match.id);
    const status = mapMetaStatus(remote.status);
    if (!status) continue;
    // Meta reclasifica la categoría al aprobar (una UTILITY puede volverse
    // MARKETING, lo que cambia el costo por conversación): es autoridad.
    const category = remote.category ?? match.category;
    const remoteBody = remote.components?.find((c) => (c.type ?? "").toUpperCase() === "BODY")?.text;
    const body = remoteBody ?? match.body;
    // Sin `rejected_reason` en el listado se conserva el que trajo el webhook.
    const rejectionReason =
      status === "rejected" ? (remote.rejected_reason || match.rejectionReason || null) : null;
    if (
      match.status === status &&
      match.category === category &&
      match.body === body &&
      match.rejectionReason === rejectionReason
    ) {
      continue;
    }
    await db
      .update(schema.template)
      .set({
        status,
        category,
        body,
        rejectionReason,
        waTemplateId: match.waTemplateId ?? remote.id ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.template.id, match.id));
    updated += 1;
  }

  // Solo con la lista COMPLETA se puede afirmar que una plantilla ya no está en Meta.
  let removed = 0;
  const gone = new Set(templatesGoneFromMeta(local, seen, listing.complete, Date.now()));
  for (const t of local) {
    if (!gone.has(t.id)) continue;
    const inUse = (await flowsUsingTemplate(organizationId, t.id)).length > 0;
    if (inUse) {
      if (t.status === "rejected" && t.rejectionReason === GONE_IN_META_REASON) continue;
      await db
        .update(schema.template)
        .set({ status: "rejected", rejectionReason: GONE_IN_META_REASON, updatedAt: new Date() })
        .where(eq(schema.template.id, t.id));
      updated += 1;
    } else {
      await db.delete(schema.template).where(eq(schema.template.id, t.id));
      removed += 1;
    }
  }
  return { updated, removed };
}

/** Evento webhook `message_template_status_update` (modo directo, FR-050). */
export async function applyTemplateStatusEvent(
  wabaId: string | null,
  value: WebhookValue
): Promise<void> {
  if (!wabaId) return;
  const creds = await getCredentialsByWabaId(wabaId);
  if (!creds) return;

  const status = mapMetaStatus(value.event);
  const name = value.message_template_name;
  const language = value.message_template_language;
  if (!status || !name || !language) return;

  const db = getDb();
  await db
    .update(schema.template)
    .set({
      status,
      rejectionReason: status === "rejected" ? (value.reason ?? null) : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.template.organizationId, creds.organizationId),
        eq(schema.template.name, name),
        eq(schema.template.language, language)
      )
    );
}

/** Envía una plantilla APROBADA a una conversación (ventana cerrada, FR-051). */
export async function sendTemplate(input: {
  organizationId: string;
  conversationId: string;
  templateId: string;
  variables?: string[];
  /** 044 — Lo manda un flujo de automatización (no cuenta como primera respuesta). */
  automatico?: boolean;
}): Promise<{ messageId: string }> {
  const db = getDb();

  const templates = await db
    .select()
    .from(schema.template)
    .where(
      scoped(
        schema.template.organizationId,
        input.organizationId,
        eq(schema.template.id, input.templateId)
      )
    )
    .limit(1);
  const template = templates[0];
  if (!template) throw new TemplateError("not_found", "Plantilla no encontrada");
  if (template.status !== "approved") {
    throw new TemplateError("invalid", "Solo se pueden enviar plantillas aprobadas");
  }
  // Meta exige EXACTAMENTE un parámetro por variable del cuerpo: si sobran o
  // falta alguno responde 132000 (plantilla y parámetros no coinciden).
  const variableCount = countVariables(template.body);
  const values = (input.variables ?? [])
    .slice(0, variableCount)
    .map((v) => v.trim());
  if (values.length < variableCount || values.some((v) => !v)) {
    const missing = values.findIndex((v) => !v);
    const n = missing === -1 ? values.length + 1 : missing + 1;
    throw new TemplateError(
      "invalid",
      variableCount === 1
        ? "La plantilla requiere el valor de {{1}}"
        : `La plantilla requiere ${variableCount} valores: falta {{${n}}}`
    );
  }

  const rows = await db
    .select({ conversation: schema.conversation, contact: schema.contact })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .where(
      scoped(
        schema.conversation.organizationId,
        input.organizationId,
        eq(schema.conversation.id, input.conversationId)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new TemplateError("not_found", "Conversación no encontrada");
  if (row.conversation.isTest) {
    // Aserción dura del sandbox (FR-031)
    throw new SendError(
      "sandbox_violation",
      "Conversación de prueba del Laboratorio: el envío real está prohibido"
    );
  }

  const creds = await getCredentialsByOrg(input.organizationId);
  if (!creds) throw new TemplateError("not_connected", "Sin número conectado");
  if (creds.status === "reconnect_required") {
    throw new TemplateError("reconnect_required", "Reconecta el número");
  }

  // 003: destinatario = teléfono normalizado o BSUID.
  // 003: teléfono en `to`, BSUID en `recipient` — Meta los pide en campos
  // distintos y mandar el BSUID en `to` devuelve 131026.
  const destinatario = destinatarioMeta(
    row.contact.phone ? normalizeRecipient(row.contact.phone) : null,
    row.contact.waUserId
  );
  if (!destinatario) {
    throw new TemplateError(
      "meta_error",
      "El contacto no tiene teléfono ni identidad de WhatsApp utilizable"
    );
  }

  // Monedas: la plantilla es lo que Meta cobra. Con el corte activo y sin saldo no sale (antes de crear la fila:
  // no queda una burbuja fallida por algo que no es del envío). En modo sombra deja pasar y lo anota.
  const consumo = { channel: "whatsapp", template: true, templateCategory: template.category } as const;
  const permiso = await puedeEnviar(input.organizationId, consumo);
  if (!permiso.allow) {
    throw new SendError("no_credit", "Sin monedas suficientes para enviar plantillas. Recarga tu saldo para continuar.");
  }

  // 041: la fila existe antes de llamar a Graph; un fallo deja una burbuja `failed` con el motivo.
  const { messageId } = await enviarYRegistrar({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    automatico: input.automatico,
    consumo,
    fila: {
      type: "template",
      text: renderBody(template.body, values),
      origin: "template",
    },
    estadoAlAceptar: "pending",
    enviar: () =>
      callGraphSend(creds, {
        messaging_product: "whatsapp",
        ...destinatario,
        type: "template",
        template: {
          name: template.name,
          language: { code: template.language },
          ...(variableCount > 0
            ? {
                components: [
                  {
                    type: "body",
                    parameters: values.map((text) => ({ type: "text", text })),
                  },
                ],
              }
            : {}),
        },
      }),
  });
  return { messageId };
}
