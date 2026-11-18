import { and, asc, eq, inArray, lte, or, isNull, sql, between } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  chunk,
  MAX_ATTEMPTS,
  RECHECK_FAILED_MS,
  RECHECK_NOT_FOUND_MS,
  STALE_MS,
  transientBackoffMs,
  type AccountSpendRow,
  type AdNode,
  type SpendRow,
} from "@/lib/meta/ads";
import { emitDeferredAdReferrals } from "@/server/automation/ad-referral-deferred";
import { hasMetaAdsSettings } from "@/server/attribution/meta-ads/settings";

/**
 * 038 — El catálogo de anuncios de Meta y su cola.
 *
 * `meta_ad` es las dos cosas: una fila `pending` vencida ES la tarea. Misma
 * disciplina que `automation_queue`: se reclama con `FOR UPDATE SKIP LOCKED` y
 * una toma (`locked_at`) que vence sola, así un proceso caído a mitad no deja
 * tareas huérfanas ni dos instancias hacen el mismo trabajo.
 */

export type MetaAdRow = typeof schema.metaAd.$inferSelect;

/** Una toma sin terminar se da por perdida pasados 10 minutos. */
const LOCK_TTL_MS = 10 * 60_000;
/** Atribuciones más viejas que esto ya no justifican consultar a Meta. */
export const RECENT_DAYS = 90;

const recientes = (now: Date) => new Date(now.getTime() - RECENT_DAYS * 86_400_000);

/**
 * La ingesta de un mensaje de anuncio: deja el anuncio en la cola si hace falta.
 * Una consulta de existencia + un upsert local; NUNCA llama a Meta y nunca
 * lanza (el mensaje del cliente ya entró).
 */
export async function enqueueAdLookup(input: {
  organizationId: string;
  sourceId: string | null;
  sourceType: string | null;
  now?: Date;
}): Promise<boolean> {
  try {
    if (!input.sourceId || (input.sourceType ?? "ad") === "post") return false;
    if (!(await hasMetaAdsSettings(input.organizationId))) return false;
    const now = input.now ?? new Date();
    const staleBefore = new Date(now.getTime() - STALE_MS);
    const rows = await getDb()
      .insert(schema.metaAd)
      .values({
        id: newId("metaAd"),
        organizationId: input.organizationId,
        adId: input.sourceId,
        status: "pending",
        nextAttemptAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.metaAd.organizationId, schema.metaAd.adId],
        set: { status: "pending", attempts: 0, nextAttemptAt: now, updatedAt: now },
        // Solo lo ya sincronizado y viejo vuelve a la cola: lo pendiente, fallido o
        // ausente sigue su propio calendario.
        setWhere: sql`${schema.metaAd.status} = 'synced' and ${schema.metaAd.syncedAt} < ${staleBefore.toISOString()}`,
      })
      .returning({ id: schema.metaAd.id });
    return rows.length > 0;
  } catch (err) {
    console.warn(
      "[meta-ads] no se pudo encolar el anuncio:",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/** Al guardar credenciales: se encolan todos los anuncios que ya trajeron gente. */
export async function enqueueAllFromAttributions(organizationId: string, now = new Date()): Promise<number> {
  const db = getDb();
  const ids = await db
    .selectDistinct({ sourceId: schema.adAttribution.sourceId })
    .from(schema.adAttribution)
    .where(
      scoped(
        schema.adAttribution.organizationId,
        organizationId,
        sql`${schema.adAttribution.sourceId} is not null`,
        sql`coalesce(${schema.adAttribution.sourceType}, 'ad') <> 'post'`
      )
    );
  let n = 0;
  for (const lote of chunk(
    ids.map((r) => r.sourceId).filter((v): v is string => !!v),
    500
  )) {
    const res = await db
      .insert(schema.metaAd)
      .values(
        lote.map((adId) => ({
          id: newId("metaAd"),
          organizationId,
          adId,
          status: "pending" as const,
          nextAttemptAt: now,
        }))
      )
      .onConflictDoNothing({ target: [schema.metaAd.organizationId, schema.metaAd.adId] })
      .returning({ id: schema.metaAd.id });
    n += res.length;
  }
  return n;
}

/** Reclama hasta `limit` consultas vencidas de la organización. */
export async function claimDue(organizationId: string, limit: number, now: Date): Promise<MetaAdRow[]> {
  return getDb().transaction(async (tx) => {
    const picked = await tx
      .select({ id: schema.metaAd.id })
      .from(schema.metaAd)
      .where(
        scoped(
          schema.metaAd.organizationId,
          organizationId,
          eq(schema.metaAd.status, "pending"),
          lte(schema.metaAd.nextAttemptAt, now),
          or(isNull(schema.metaAd.lockedAt), lte(schema.metaAd.lockedAt, new Date(now.getTime() - LOCK_TTL_MS)))
        )
      )
      .orderBy(asc(schema.metaAd.nextAttemptAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (picked.length === 0) return [];
    return tx
      .update(schema.metaAd)
      .set({ lockedAt: now })
      .where(inArray(schema.metaAd.id, picked.map((p) => p.id)))
      .returning();
  });
}

export async function markSynced(organizationId: string, nodes: AdNode[], now: Date): Promise<void> {
  if (nodes.length === 0) return;
  await markSyncedRows(organizationId, nodes, now);
  // 047 — Con la jerarquía ya conocida, los flujos de conjunto/campaña que esperaban a este anuncio se evalúan. Nunca lanza.
  await emitDeferredAdReferrals(organizationId, nodes.map((n) => n.adId));
}

async function markSyncedRows(organizationId: string, nodes: AdNode[], now: Date): Promise<void> {
  await getDb().transaction(async (tx) => {
    for (const n of nodes) {
      await tx
        .update(schema.metaAd)
        .set({
          adName: n.adName,
          adsetId: n.adsetId,
          adsetName: n.adsetName,
          campaignId: n.campaignId,
          campaignName: n.campaignName,
          status: "synced",
          attempts: 0,
          lockedAt: null,
          lastError: null,
          syncedAt: now,
          nextAttemptAt: now,
          updatedAt: now,
        })
        .where(scoped(schema.metaAd.organizationId, organizationId, eq(schema.metaAd.adId, n.adId)));
    }
  });
}

/** El anuncio no aparece en la cuenta (borrado, o de otra cuenta). Se vuelve a mirar en 24 h. */
export async function markNotFound(organizationId: string, adIds: string[], now: Date): Promise<void> {
  if (adIds.length === 0) return;
  await getDb()
    .update(schema.metaAd)
    .set({
      status: "not_found",
      lockedAt: null,
      lastError: "No aparece en esta cuenta publicitaria",
      nextAttemptAt: new Date(now.getTime() + RECHECK_NOT_FOUND_MS),
      updatedAt: now,
    })
    .where(scoped(schema.metaAd.organizationId, organizationId, inArray(schema.metaAd.adId, adIds)));
}

/** Fallo transitorio: un intento más y espera creciente; al llegar al tope pasa a `failed`. */
export async function markRetry(
  organizationId: string,
  adIds: string[],
  message: string,
  now: Date
): Promise<void> {
  if (adIds.length === 0) return;
  const db = getDb();
  const rows = await db
    .select({ adId: schema.metaAd.adId, attempts: schema.metaAd.attempts })
    .from(schema.metaAd)
    .where(scoped(schema.metaAd.organizationId, organizationId, inArray(schema.metaAd.adId, adIds)));
  for (const r of rows) {
    const attempts = r.attempts + 1;
    const agotado = attempts >= MAX_ATTEMPTS;
    await db
      .update(schema.metaAd)
      .set({
        attempts,
        status: agotado ? "failed" : "pending",
        lockedAt: null,
        lastError: message,
        nextAttemptAt: new Date(now.getTime() + (agotado ? RECHECK_FAILED_MS : transientBackoffMs(attempts))),
        updatedAt: now,
      })
      .where(scoped(schema.metaAd.organizationId, organizationId, eq(schema.metaAd.adId, r.adId)));
  }
}

/** Fallo permanente: no se reintenta antes del siguiente ciclo de 12 h. */
export async function markFailed(organizationId: string, adIds: string[], message: string, now: Date): Promise<void> {
  if (adIds.length === 0) return;
  await getDb()
    .update(schema.metaAd)
    .set({
      status: "failed",
      attempts: sql`${schema.metaAd.attempts} + 1`,
      lockedAt: null,
      lastError: message,
      nextAttemptAt: new Date(now.getTime() + RECHECK_FAILED_MS),
      updatedAt: now,
    })
    .where(scoped(schema.metaAd.organizationId, organizationId, inArray(schema.metaAd.adId, adIds)));
}

/** Suelta la toma sin gastar un intento (límite de uso, token caído): la tarea queda como estaba. */
export async function releaseLocks(organizationId: string, adIds: string[]): Promise<void> {
  if (adIds.length === 0) return;
  await getDb()
    .update(schema.metaAd)
    .set({ lockedAt: null })
    .where(scoped(schema.metaAd.organizationId, organizationId, inArray(schema.metaAd.adId, adIds)));
}

/**
 * El barrido que devuelve a la cola lo que toca revisar de nuevo:
 *  - lo sincronizado hace más de 12 h (los nombres se cambian), si el anuncio sigue trayendo gente;
 *  - lo fallido o ausente cuyo plazo venció.
 */
export async function refreshStale(organizationId: string, now: Date): Promise<void> {
  const db = getDb();
  const staleBefore = new Date(now.getTime() - STALE_MS);
  const cutoff = recientes(now);
  const conAtribucionReciente = sql`exists (
    select 1 from "ad_attribution" a
    where a."organization_id" = ${schema.metaAd.organizationId}
      and a."source_id" = ${schema.metaAd.adId}
      and a."created_at" >= ${cutoff.toISOString()}
  )`;

  await db
    .update(schema.metaAd)
    .set({ status: "pending", attempts: 0, nextAttemptAt: now, updatedAt: now })
    .where(
      scoped(
        schema.metaAd.organizationId,
        organizationId,
        eq(schema.metaAd.status, "synced"),
        lte(schema.metaAd.syncedAt, staleBefore),
        conAtribucionReciente
      )
    );
  await db
    .update(schema.metaAd)
    .set({ status: "pending", attempts: 0, nextAttemptAt: now, updatedAt: now })
    .where(
      scoped(
        schema.metaAd.organizationId,
        organizationId,
        eq(schema.metaAd.status, "failed"),
        lte(schema.metaAd.nextAttemptAt, now)
      )
    );
  await db
    .update(schema.metaAd)
    .set({ status: "pending", attempts: 0, nextAttemptAt: now, updatedAt: now })
    .where(
      scoped(
        schema.metaAd.organizationId,
        organizationId,
        eq(schema.metaAd.status, "not_found"),
        lte(schema.metaAd.nextAttemptAt, now),
        conAtribucionReciente
      )
    );
}

/** Anuncios ya identificados que siguen trayendo gente: a los que se les pide el gasto. */
export async function adsForSpend(
  organizationId: string,
  now: Date
): Promise<{ adId: string; spendSyncedAt: Date | null }[]> {
  const cutoff = recientes(now);
  return getDb()
    .select({ adId: schema.metaAd.adId, spendSyncedAt: schema.metaAd.spendSyncedAt })
    .from(schema.metaAd)
    .where(
      scoped(
        schema.metaAd.organizationId,
        organizationId,
        eq(schema.metaAd.status, "synced"),
        sql`exists (
          select 1 from "ad_attribution" a
          where a."organization_id" = ${schema.metaAd.organizationId}
            and a."source_id" = ${schema.metaAd.adId}
            and a."created_at" >= ${cutoff.toISOString()}
        )`
      )
    );
}

/**
 * Sustituye el gasto de esos anuncios en `[since, until]` por lo que Meta dice
 * AHORA: Meta revisa cifras recientes y un día que ya no trae fila vale 0, así
 * que reemplazar la ventana entera es lo único correcto (y es idempotente).
 */
export async function replaceSpend(input: {
  organizationId: string;
  adIds: string[];
  since: string;
  until: string;
  rows: SpendRow[];
  now: Date;
}): Promise<void> {
  const { organizationId, adIds, since, until, rows, now } = input;
  if (adIds.length === 0) return;
  await getDb().transaction(async (tx) => {
    await tx
      .delete(schema.metaAdSpend)
      .where(
        scoped(
          schema.metaAdSpend.organizationId,
          organizationId,
          inArray(schema.metaAdSpend.adId, adIds),
          between(schema.metaAdSpend.day, since, until)
        )
      );
    for (const lote of chunk(rows, 500)) {
      if (lote.length === 0) continue;
      await tx
        .insert(schema.metaAdSpend)
        .values(
          lote.map((r) => ({
            id: newId("metaAdSpend"),
            organizationId,
            adId: r.adId,
            day: r.day,
            spend: r.spend,
            currency: r.currency,
            syncedAt: now,
          }))
        )
        .onConflictDoUpdate({
          target: [schema.metaAdSpend.organizationId, schema.metaAdSpend.adId, schema.metaAdSpend.day],
          set: { spend: sql`excluded.spend`, currency: sql`excluded.currency`, syncedAt: now },
        });
    }
    await tx
      .update(schema.metaAd)
      .set({ spendSyncedAt: now })
      .where(scoped(schema.metaAd.organizationId, organizationId, inArray(schema.metaAd.adId, adIds)));
  });
}

export async function countsByStatus(organizationId: string): Promise<{ pending: number; failed: number }> {
  const rows = await getDb()
    .select({ status: schema.metaAd.status, n: sql<number>`count(*)::int` })
    .from(schema.metaAd)
    .where(and(scoped(schema.metaAd.organizationId, organizationId), inArray(schema.metaAd.status, ["pending", "failed"])))
    .groupBy(schema.metaAd.status);
  return {
    pending: rows.find((r) => r.status === "pending")?.n ?? 0,
    failed: rows.find((r) => r.status === "failed")?.n ?? 0,
  };
}

/* ── 039 — la cuenta como fuente ────────────────────────────────── */

/**
 * Upsert de lo que devolvió el listado de la CUENTA (o la jerarquía que trae el gasto). Un anuncio que ya
 * estaba se actualiza SIN pisar un nombre con `null`; uno nuevo entra ya como `synced`. El listado de la cuenta
 * (`listed: true`) además marca `listed_at` y trae el estado efectivo.
 */
export async function upsertAccountAds(
  organizationId: string,
  nodes: AdNode[],
  now: Date,
  opts: { listed: boolean }
): Promise<number> {
  const db = getDb();
  let n = 0;
  for (const lote of chunk(nodes, 200)) {
    if (lote.length === 0) continue;
    const res = await db
      .insert(schema.metaAd)
      .values(
        lote.map((a) => ({
          id: newId("metaAd"),
          organizationId,
          adId: a.adId,
          adName: a.adName,
          adsetId: a.adsetId,
          adsetName: a.adsetName,
          campaignId: a.campaignId,
          campaignName: a.campaignName,
          effectiveStatus: a.effectiveStatus ?? null,
          creativeId: a.creative?.creativeId ?? null,
          creativeTitle: a.creative?.title ?? null,
          creativeBody: a.creative?.body ?? null,
          creativeThumbUrl: a.creative?.thumbnailUrl ?? null,
          creativeImageUrl: a.creative?.imageUrl ?? null,
          previewLink: a.previewLink ?? null,
          status: "synced" as const,
          syncedAt: now,
          listedAt: opts.listed ? now : null,
          nextAttemptAt: now,
        }))
      )
      .onConflictDoUpdate({
        target: [schema.metaAd.organizationId, schema.metaAd.adId],
        set: {
          adName: sql`coalesce(excluded.ad_name, ${schema.metaAd.adName})`,
          adsetId: sql`coalesce(excluded.adset_id, ${schema.metaAd.adsetId})`,
          adsetName: sql`coalesce(excluded.adset_name, ${schema.metaAd.adsetName})`,
          campaignId: sql`coalesce(excluded.campaign_id, ${schema.metaAd.campaignId})`,
          campaignName: sql`coalesce(excluded.campaign_name, ${schema.metaAd.campaignName})`,
          effectiveStatus: opts.listed
            ? sql`excluded.effective_status`
            : sql`coalesce(${schema.metaAd.effectiveStatus}, excluded.effective_status)`,
          // 040 — el creativo: lo nuevo entra, lo ya conocido no se pisa con null (el listado sin creativos no lo borra).
          creativeId: sql`coalesce(excluded.creative_id, ${schema.metaAd.creativeId})`,
          creativeTitle: sql`coalesce(excluded.creative_title, ${schema.metaAd.creativeTitle})`,
          creativeBody: sql`coalesce(excluded.creative_body, ${schema.metaAd.creativeBody})`,
          creativeThumbUrl: sql`coalesce(excluded.creative_thumb_url, ${schema.metaAd.creativeThumbUrl})`,
          creativeImageUrl: sql`coalesce(excluded.creative_image_url, ${schema.metaAd.creativeImageUrl})`,
          previewLink: sql`coalesce(excluded.preview_link, ${schema.metaAd.previewLink})`,
          status: "synced",
          attempts: 0,
          lockedAt: null,
          lastError: null,
          syncedAt: now,
          ...(opts.listed ? { listedAt: now } : {}),
          updatedAt: now,
        },
      })
      .returning({ id: schema.metaAd.id });
    n += res.length;
  }
  // 047 — Idem `markSynced`: la jerarquía que trajo el listado puede resolver anuncios que esperaban a su conjunto/campaña.
  await emitDeferredAdReferrals(organizationId, nodes.map((x) => x.adId));
  return n;
}

/**
 * Sustituye TODO el gasto de la organización en `[since, until]` por lo que Meta dice ahora, sin lista de ids:
 * lo que Meta ya no devuelve para un día se va (un anuncio borrado, un ajuste). Quien llama garantiza que
 * `rows` es la ventana COMPLETA: una paginación cortada no debe llegar aquí (dinero parcial es peor que viejo).
 */
export async function replaceSpendWindow(input: {
  organizationId: string;
  since: string;
  until: string;
  rows: SpendRow[];
  now: Date;
}): Promise<void> {
  const { organizationId, since, until, rows, now } = input;
  await getDb().transaction(async (tx) => {
    await tx
      .delete(schema.metaAdSpend)
      .where(scoped(schema.metaAdSpend.organizationId, organizationId, between(schema.metaAdSpend.day, since, until)));
    for (const lote of chunk(rows, 500)) {
      if (lote.length === 0) continue;
      await tx
        .insert(schema.metaAdSpend)
        .values(
          lote.map((r) => ({
            id: newId("metaAdSpend"),
            organizationId,
            adId: r.adId,
            day: r.day,
            spend: r.spend,
            currency: r.currency,
            syncedAt: now,
          }))
        )
        .onConflictDoUpdate({
          target: [schema.metaAdSpend.organizationId, schema.metaAdSpend.adId, schema.metaAdSpend.day],
          set: { spend: sql`excluded.spend`, currency: sql`excluded.currency`, syncedAt: now },
        });
    }
    const ids = [...new Set(rows.map((r) => r.adId))];
    if (ids.length > 0) {
      await tx
        .update(schema.metaAd)
        .set({ spendSyncedAt: now })
        .where(scoped(schema.metaAd.organizationId, organizationId, inArray(schema.metaAd.adId, ids)));
    }
  });
}

/** Lo mismo para el gasto diario de la cuenta entera (con lo que se cuadra lo desglosado). */
export async function replaceAccountSpend(input: {
  organizationId: string;
  since: string;
  until: string;
  rows: AccountSpendRow[];
  now: Date;
}): Promise<void> {
  const { organizationId, since, until, rows, now } = input;
  await getDb().transaction(async (tx) => {
    await tx
      .delete(schema.metaAccountSpend)
      .where(
        scoped(schema.metaAccountSpend.organizationId, organizationId, between(schema.metaAccountSpend.day, since, until))
      );
    for (const lote of chunk(rows, 500)) {
      if (lote.length === 0) continue;
      await tx
        .insert(schema.metaAccountSpend)
        .values(
          lote.map((r) => ({
            id: newId("metaAccountSpend"),
            organizationId,
            day: r.day,
            spend: r.spend,
            currency: r.currency,
            syncedAt: now,
          }))
        )
        .onConflictDoUpdate({
          target: [schema.metaAccountSpend.organizationId, schema.metaAccountSpend.day],
          set: { spend: sql`excluded.spend`, currency: sql`excluded.currency`, syncedAt: now },
        });
    }
  });
}
