import { and, count, gte, lt, sql, sum } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import type { UsageService } from "@/lib/credits";
import { creditsEnabled } from "./flag";

/**
 * Monedas — la MEDICIÓN cruda. Una fila por llamada a la IA y por envío de WhatsApp, se cobre o no: llave del
 * cliente, Laboratorio, mensajes libres a tarifa 0. Es independiente del libro (registrar uso nunca mueve el saldo)
 * y es lo que permite calibrar las tarifas en modo sombra antes de cortar a nadie.
 */

export type UsageInput = {
  organizationId: string;
  service: UsageService;
  /** IA: de quién es la llave. */
  source?: "org" | "env" | null;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  estimated?: boolean;
  /** WhatsApp: `text` o la categoría de la plantilla. */
  category?: string | null;
  quantity?: number;
  conversationId?: string | null;
  refType?: string | null;
  refId?: string | null;
  /** Unidades que se descontaron por esto (0 = solo medido). */
  chargedUnits?: number;
  /** Con el corte activo, esto se habría bloqueado. */
  wouldCut?: boolean;
  /** Evita contar dos veces lo mismo (un reintento): la misma clave no inserta otra fila. */
  idempotencyKey?: string | null;
  meta?: Record<string, unknown> | null;
};

export type UsageResult = { status: "recorded"; id: string } | { status: "duplicate" } | { status: "disabled" };

export async function recordUsage(input: UsageInput): Promise<UsageResult> {
  if (!creditsEnabled()) return { status: "disabled" };
  const id = newId("creditUsage");
  // Sin `target`: la unicidad por clave es un índice PARCIAL (solo con clave) y ON CONFLICT DO NOTHING la cubre.
  const inserted = await getDb()
    .insert(schema.creditUsage)
    .values({
      id,
      organizationId: input.organizationId,
      service: input.service,
      source: input.source ?? null,
      model: input.model ?? null,
      tokensIn: input.tokensIn ?? null,
      tokensOut: input.tokensOut ?? null,
      estimated: input.estimated ?? false,
      category: input.category ?? null,
      quantity: Math.max(Math.floor(input.quantity ?? 1), 0),
      conversationId: input.conversationId ?? null,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      chargedUnits: Math.max(Math.floor(input.chargedUnits ?? 0), 0),
      wouldCut: input.wouldCut ?? false,
      idempotencyKey: input.idempotencyKey ?? null,
      meta: input.meta ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.creditUsage.id });
  return inserted.length > 0 ? { status: "recorded", id } : { status: "duplicate" };
}

export type UsageSummaryRow = {
  service: UsageService;
  source: "org" | "env" | null;
  category: string | null;
  events: number;
  quantity: number;
  tokensIn: number;
  tokensOut: number;
  chargedUnits: number;
  wouldCutEvents: number;
};

/** El consumo agregado en un rango (de una organización o de todas): la base para calibrar tarifas. Solo lectura. */
export async function usageSummary(input: { from: Date; to: Date; organizationId?: string }): Promise<UsageSummaryRow[]> {
  const u = schema.creditUsage;
  const rows = await getDb()
    .select({
      service: u.service,
      source: u.source,
      category: u.category,
      events: count(),
      quantity: sum(u.quantity),
      tokensIn: sum(u.tokensIn),
      tokensOut: sum(u.tokensOut),
      chargedUnits: sum(u.chargedUnits),
      wouldCutEvents: sql<number>`count(*) filter (where ${u.wouldCut})`,
    })
    .from(u)
    .where(
      input.organizationId
        ? scoped(u.organizationId, input.organizationId, gte(u.createdAt, input.from), lt(u.createdAt, input.to))
        : and(gte(u.createdAt, input.from), lt(u.createdAt, input.to))
    )
    .groupBy(u.service, u.source, u.category)
    .orderBy(u.service, u.source, u.category);
  return rows.map((r) => ({
    service: r.service,
    source: r.source,
    category: r.category,
    events: Number(r.events),
    quantity: Number(r.quantity ?? 0),
    tokensIn: Number(r.tokensIn ?? 0),
    tokensOut: Number(r.tokensOut ?? 0),
    chargedUnits: Number(r.chargedUnits ?? 0),
    wouldCutEvents: Number(r.wouldCutEvents ?? 0),
  }));
}

