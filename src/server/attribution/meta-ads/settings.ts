import { and, eq, isNull, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { graphRequest } from "@/lib/meta/client";
import { buildAccountPath } from "@/lib/meta/ads";

/**
 * 038 — Credenciales de la Marketing API del negocio.
 *
 * El token se cifra con el mismo mecanismo que el de WhatsApp (`lib/crypto`,
 * AES-256-GCM). NO se reutiliza el de WhatsApp (a diferencia de CAPI): rara vez
 * trae `ads_read`. Al cliente solo salen sus últimos 4.
 */

export type MetaAdsSettings = {
  adAccountId: string;
  token: string;
  status: "connected" | "error";
  lastError: string | null;
  accountName: string | null;
  currency: string | null;
  pausedUntil: Date | null;
  rateHits: number;
  lastSpendSyncAt: Date | null;
  /** 039 */
  catalogSyncedAt: Date | null;
  spendCoveredSince: string | null;
  spendBackfillFrom: string | null;
  accountTimezone: string | null;
};

export type MetaAdsSettingsView = {
  adAccountId: string;
  tokenLast4: string;
  status: "connected" | "error";
  lastError: string | null;
  accountName: string | null;
  currency: string | null;
  pausedUntil: string | null;
  lastSpendSyncAt: string | null;
  /** 039 — Último listado completo de la cuenta y desde qué día hay gasto. */
  catalogSyncedAt: string | null;
  spendCoveredSince: string | null;
  accountTimezone: string | null;
  /** Anuncios por consultar y anuncios que no se pudieron leer. */
  pending: number;
  failed: number;
};

type Row = typeof schema.metaAdsSettings.$inferSelect;

function fromRow(row: Row): MetaAdsSettings {
  return {
    adAccountId: row.adAccountId,
    token: decryptSecret({ cipher: row.tokenCipher, iv: row.tokenIv, tag: row.tokenTag }),
    status: row.status,
    lastError: row.lastError,
    accountName: row.accountName,
    currency: row.currency,
    pausedUntil: row.pausedUntil,
    rateHits: row.rateHits,
    lastSpendSyncAt: row.lastSpendSyncAt,
    catalogSyncedAt: row.catalogSyncedAt,
    spendCoveredSince: row.spendCoveredSince,
    spendBackfillFrom: row.spendBackfillFrom,
    accountTimezone: row.accountTimezone,
  };
}

export async function getMetaAdsSettings(organizationId: string): Promise<MetaAdsSettings | null> {
  const rows = await getDb()
    .select()
    .from(schema.metaAdsSettings)
    .where(scoped(schema.metaAdsSettings.organizationId, organizationId))
    .limit(1);
  return rows[0] ? fromRow(rows[0]) : null;
}

/** ¿Hay credenciales? Una consulta indexada y sin descifrar: la usa la ingesta. */
export async function hasMetaAdsSettings(organizationId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: schema.metaAdsSettings.id })
    .from(schema.metaAdsSettings)
    .where(scoped(schema.metaAdsSettings.organizationId, organizationId))
    .limit(1);
  return rows.length > 0;
}

export async function getMetaAdsView(
  organizationId: string,
  counts: { pending: number; failed: number }
): Promise<MetaAdsSettingsView | null> {
  const s = await getMetaAdsSettings(organizationId);
  if (!s) return null;
  return {
    adAccountId: s.adAccountId,
    tokenLast4: s.token.slice(-4),
    status: s.status,
    lastError: s.lastError,
    accountName: s.accountName,
    currency: s.currency,
    pausedUntil: s.pausedUntil?.toISOString() ?? null,
    lastSpendSyncAt: s.lastSpendSyncAt?.toISOString() ?? null,
    catalogSyncedAt: s.catalogSyncedAt?.toISOString() ?? null,
    spendCoveredSince: s.spendCoveredSince,
    accountTimezone: s.accountTimezone,
    pending: counts.pending,
    failed: counts.failed,
  };
}

/** «Probar conexión»: lee la cuenta con el token. Lanza `MetaApiError` si Meta la rechaza. */
export async function fetchAccountInfo(
  adAccountId: string,
  token: string
): Promise<{ name: string | null; currency: string | null; timezone: string | null }> {
  const res = await graphRequest<{ name?: string; currency?: string; timezone_name?: string }>(
    buildAccountPath(adAccountId),
    { token }
  );
  return {
    name: typeof res?.name === "string" ? res.name : null,
    currency: typeof res?.currency === "string" ? res.currency : null,
    timezone: typeof res?.timezone_name === "string" ? res.timezone_name : null,
  };
}

export async function saveMetaAdsSettings(input: {
  organizationId: string;
  adAccountId: string;
  token: string;
  accountName: string | null;
  currency: string | null;
  timezone?: string | null;
}): Promise<void> {
  const enc = encryptSecret(input.token);
  await getDb()
    .insert(schema.metaAdsSettings)
    .values({
      id: newId("metaAdsSettings"),
      organizationId: input.organizationId,
      adAccountId: input.adAccountId,
      tokenCipher: enc.cipher,
      tokenIv: enc.iv,
      tokenTag: enc.tag,
      accountName: input.accountName,
      currency: input.currency,
      accountTimezone: input.timezone ?? null,
    })
    .onConflictDoUpdate({
      target: [schema.metaAdsSettings.organizationId],
      set: {
        adAccountId: input.adAccountId,
        tokenCipher: enc.cipher,
        tokenIv: enc.iv,
        tokenTag: enc.tag,
        accountName: input.accountName,
        currency: input.currency,
        accountTimezone: input.timezone ?? null,
        status: "connected",
        lastError: null,
        pausedUntil: null,
        rateHits: 0,
        updatedAt: new Date(),
      },
    });
}

/**
 * Desconectar. El catálogo y el gasto ya traídos se CONSERVAN (son historia,
 * como los eventos de CAPI); solo se tiran las consultas que nunca llegaron a
 * traer nada.
 */
export async function deleteMetaAdsSettings(organizationId: string): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.metaAdsSettings)
    .where(scoped(schema.metaAdsSettings.organizationId, organizationId));
  await db
    .delete(schema.metaAd)
    .where(
      scoped(
        schema.metaAd.organizationId,
        organizationId,
        eq(schema.metaAd.status, "pending"),
        isNull(schema.metaAd.syncedAt)
      )
    );
}

/** El token ya no sirve (o no ve la cuenta): todo se detiene hasta que el dueño lo cambie. */
export async function markSettingsError(organizationId: string, message: string): Promise<void> {
  await getDb()
    .update(schema.metaAdsSettings)
    .set({ status: "error", lastError: message, updatedAt: new Date() })
    .where(scoped(schema.metaAdsSettings.organizationId, organizationId));
}

export async function setPausedUntil(
  organizationId: string,
  pausedUntil: Date,
  rateHits: number,
  message: string | null
): Promise<void> {
  await getDb()
    .update(schema.metaAdsSettings)
    .set({ pausedUntil, rateHits, ...(message ? { lastError: message } : {}), updatedAt: new Date() })
    .where(scoped(schema.metaAdsSettings.organizationId, organizationId));
}

/** Una llamada salió bien: se acaba el castigo por límite y se limpia el último error. */
export async function clearRateLimit(organizationId: string): Promise<void> {
  await getDb()
    .update(schema.metaAdsSettings)
    .set({ pausedUntil: null, rateHits: 0, lastError: null, updatedAt: new Date() })
    .where(
      and(
        scoped(schema.metaAdsSettings.organizationId, organizationId),
        eq(schema.metaAdsSettings.status, "connected")
      )
    );
}

export async function touchSpendSync(organizationId: string, at: Date): Promise<void> {
  await getDb()
    .update(schema.metaAdsSettings)
    .set({ lastSpendSyncAt: at })
    .where(scoped(schema.metaAdsSettings.organizationId, organizationId));
}

export async function setCurrencyIfMissing(organizationId: string, currency: string): Promise<void> {
  await getDb()
    .update(schema.metaAdsSettings)
    .set({ currency })
    .where(scoped(schema.metaAdsSettings.organizationId, organizationId, isNull(schema.metaAdsSettings.currency)));
}

/** Organizaciones que sincronizar: con credenciales sanas. */
export async function connectedOrganizations(): Promise<string[]> {
  const rows = await getDb()
    .select({ id: schema.metaAdsSettings.organizationId })
    .from(schema.metaAdsSettings)
    .where(eq(schema.metaAdsSettings.status, "connected"));
  return rows.map((r) => r.id);
}

/** 039 — Terminó un listado completo de la cuenta. */
export async function touchCatalogSync(organizationId: string, at: Date, timezone: string | null): Promise<void> {
  await getDb()
    .update(schema.metaAdsSettings)
    .set({ catalogSyncedAt: at, ...(timezone ? { accountTimezone: timezone } : {}) })
    .where(scoped(schema.metaAdsSettings.organizationId, organizationId));
}

/**
 * 039 — Resultados pide un rango que empieza antes de lo cubierto: se anota hasta qué día hay que rellenar.
 * Un `UPDATE` local de una columna; la ruta de lectura NUNCA llama a Meta. Solo adelanta (nunca borra un pedido
 * más antiguo que ya estaba).
 */
export async function requestSpendBackfill(organizationId: string, fromDay: string): Promise<void> {
  await getDb()
    .update(schema.metaAdsSettings)
    .set({ spendBackfillFrom: sql`least(coalesce(${schema.metaAdsSettings.spendBackfillFrom}, ${fromDay}::date), ${fromDay}::date)` })
    .where(scoped(schema.metaAdsSettings.organizationId, organizationId));
}

/** 039 — Una pasada de gasto terminó completa: hasta dónde hay datos y, si el pedido quedó cubierto, se limpia. */
export async function setSpendCoverage(organizationId: string, coveredSince: string): Promise<void> {
  await getDb()
    .update(schema.metaAdsSettings)
    .set({
      spendCoveredSince: sql`least(coalesce(${schema.metaAdsSettings.spendCoveredSince}, ${coveredSince}::date), ${coveredSince}::date)`,
      spendBackfillFrom: sql`case when ${schema.metaAdsSettings.spendBackfillFrom} is not null and ${schema.metaAdsSettings.spendBackfillFrom} >= ${coveredSince}::date then null else ${schema.metaAdsSettings.spendBackfillFrom} end`,
    })
    .where(scoped(schema.metaAdsSettings.organizationId, organizationId));
}

/** 039 — Un aviso (no un error): lo traído se guardó, pero algo quedó sin completarse. */
export async function setSyncWarning(organizationId: string, message: string): Promise<void> {
  await getDb()
    .update(schema.metaAdsSettings)
    .set({ lastError: message.slice(0, 300) })
    .where(scoped(schema.metaAdsSettings.organizationId, organizationId));
}
