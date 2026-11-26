import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { scoped } from "@/lib/db/tenant";

/**
 * 015 — Las credenciales de Google Calendar de un negocio (una cuenta y un calendario por organización).
 *
 * Paso 3 — Dos orígenes:
 *  - `oauth`: el botón «Conectar con Google», con la app OAuth de la INSTANCIA. Aquí solo se guarda el
 *    refresh token (cifrado) y la cuenta; el client secret vive en `GOOGLE_OAUTH_CLIENT_SECRET` y no se
 *    copia a la base. Si quien opera el servidor quita esa app, la conexión deja de servir (se informa).
 *  - `manual` (Avanzado): el negocio pega Client ID, Client Secret y refresh token de su propia app.
 *
 * Secretos con AES-256-GCM, como el resto. Hacia fuera nunca sale un secreto.
 */

export type GoogleCreds = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
  status: "connected" | "error";
};

export type GoogleConnectionInfo = {
  source: "oauth" | "manual";
  status: "connected" | "error";
  calendarId: string;
  clientId: string;
  accountEmail: string | null;
  connectedAt: Date | null;
  lastError: string | null;
  lastOkAt: Date | null;
  /** Últimos 4 del secreto (solo `manual`). */
  secretLast4: string | null;
  /** `oauth` sin la app de la instancia configurada: no hay con qué renovar el token. */
  appMissing: boolean;
};

/** La app OAuth de la instancia, si quien opera el servidor la configuró. */
export function instanceOAuthApp(): { clientId: string; clientSecret: string } | null {
  const env = getEnv();
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

type Row = typeof schema.googleCredentials.$inferSelect;

async function readRow(organizationId: string): Promise<Row | null> {
  const rows = await getDb()
    .select()
    .from(schema.googleCredentials)
    .where(scoped(schema.googleCredentials.organizationId, organizationId))
    .limit(1);
  return rows[0] ?? null;
}

function storedSecret(row: Row): string | null {
  if (!row.clientSecretCipher || !row.clientSecretIv || !row.clientSecretTag) return null;
  return decryptSecret({ cipher: row.clientSecretCipher, iv: row.clientSecretIv, tag: row.clientSecretTag });
}

/**
 * Las credenciales listas para llamar a Google, o `null` si no hay conexión utilizable (sin fila, o una
 * conexión OAuth cuya app de instancia ya no está configurada).
 */
export async function getGoogleCredentials(organizationId: string): Promise<GoogleCreds | null> {
  const row = await readRow(organizationId);
  if (!row) return null;
  const refreshToken = decryptSecret({
    cipher: row.refreshTokenCipher,
    iv: row.refreshTokenIv,
    tag: row.refreshTokenTag,
  });
  if (row.source === "oauth") {
    const app = instanceOAuthApp();
    if (!app) return null;
    return { clientId: app.clientId, clientSecret: app.clientSecret, refreshToken, calendarId: row.calendarId, status: row.status };
  }
  const clientSecret = storedSecret(row);
  if (!clientSecret) return null;
  return { clientId: row.clientId, clientSecret, refreshToken, calendarId: row.calendarId, status: row.status };
}

/** Lo que Ajustes puede mostrar (sin secretos). */
export async function getGoogleConnectionInfo(organizationId: string): Promise<GoogleConnectionInfo | null> {
  const row = await readRow(organizationId);
  if (!row) return null;
  const secret = row.source === "manual" ? storedSecret(row) : null;
  return {
    source: row.source,
    status: row.status,
    calendarId: row.calendarId,
    clientId: row.source === "manual" ? row.clientId : "",
    accountEmail: row.accountEmail,
    connectedAt: row.connectedAt,
    lastError: row.lastError,
    lastOkAt: row.lastOkAt,
    secretLast4: secret ? secretLast4(secret) : null,
    appMissing: row.source === "oauth" && !instanceOAuthApp(),
  };
}

/** Modo Avanzado: el negocio pega las credenciales de su propia app. */
export async function saveGoogleCredentials(input: {
  organizationId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId?: string | null;
}): Promise<void> {
  const secret = encryptSecret(input.clientSecret);
  await upsertRow(input.organizationId, {
    source: "manual",
    clientId: input.clientId,
    clientSecretCipher: secret.cipher,
    clientSecretIv: secret.iv,
    clientSecretTag: secret.tag,
    refreshToken: input.refreshToken,
    calendarId: input.calendarId,
    accountEmail: null,
  });
}

/** «Conectar con Google»: el refresh token que devolvió el flujo OAuth de la app de la instancia. */
export async function saveGoogleOAuthConnection(input: {
  organizationId: string;
  clientId: string;
  refreshToken: string;
  accountEmail: string | null;
  calendarId?: string | null;
}): Promise<void> {
  await upsertRow(input.organizationId, {
    source: "oauth",
    clientId: input.clientId,
    clientSecretCipher: null,
    clientSecretIv: null,
    clientSecretTag: null,
    refreshToken: input.refreshToken,
    calendarId: input.calendarId,
    accountEmail: input.accountEmail,
  });
}

async function upsertRow(
  organizationId: string,
  input: {
    source: "oauth" | "manual";
    clientId: string;
    clientSecretCipher: string | null;
    clientSecretIv: string | null;
    clientSecretTag: string | null;
    refreshToken: string;
    calendarId?: string | null;
    accountEmail: string | null;
  }
): Promise<void> {
  const refresh = encryptSecret(input.refreshToken);
  const now = new Date();
  const values = {
    source: input.source,
    clientId: input.clientId,
    clientSecretCipher: input.clientSecretCipher,
    clientSecretIv: input.clientSecretIv,
    clientSecretTag: input.clientSecretTag,
    refreshTokenCipher: refresh.cipher,
    refreshTokenIv: refresh.iv,
    refreshTokenTag: refresh.tag,
    calendarId: input.calendarId?.trim() || "primary",
    status: "connected" as const,
    accountEmail: input.accountEmail,
    connectedAt: now,
    lastError: null,
    lastOkAt: now,
    // Paso 4: una conexión nueva (o reconectar tras un permiso que faltaba) vuelve a leer lo ocupado ya.
    busyStatus: null,
    busyError: null,
    busyAttempts: 0,
    busyNextAt: null,
  };
  await getDb()
    .insert(schema.googleCredentials)
    .values({ id: newId("googleCredentials"), organizationId, ...values })
    .onConflictDoUpdate({
      target: [schema.googleCredentials.organizationId],
      set: { ...values, updatedAt: now },
    });
  clearGoogleTokenCache();
}

export async function deleteGoogleCredentials(organizationId: string): Promise<void> {
  await getDb()
    .delete(schema.googleCredentials)
    .where(scoped(schema.googleCredentials.organizationId, organizationId));
  clearGoogleTokenCache();
}

/**
 * El estado `error` se escribe de verdad (ver zoom-credentials). Devuelve `true` si la conexión ACABA de
 * romperse (estaba `connected`): así el aviso al equipo sale una sola vez, no en cada reintento.
 */
export async function markGoogleError(organizationId: string, message?: string): Promise<boolean> {
  const rows = await getDb()
    .update(schema.googleCredentials)
    .set({ status: "error", lastError: message?.slice(0, 500) ?? "Google rechazó las credenciales", updatedAt: new Date() })
    .where(
      scoped(
        schema.googleCredentials.organizationId,
        organizationId,
        eq(schema.googleCredentials.status, "connected")
      )
    )
    .returning({ id: schema.googleCredentials.id });
  return rows.length > 0;
}

/** Una llamada a Google salió bien: queda registrado para Ajustes y se limpia el último error transitorio. */
export async function markGoogleOk(organizationId: string): Promise<void> {
  await getDb()
    .update(schema.googleCredentials)
    .set({ lastOkAt: new Date(), lastError: null })
    .where(
      scoped(
        schema.googleCredentials.organizationId,
        organizationId,
        eq(schema.googleCredentials.status, "connected")
      )
    );
}

/** Un fallo que NO rompe la conexión (Google caído, 429…): se anota para Ajustes, sin cambiar el estado. */
export async function noteGoogleError(organizationId: string, message: string): Promise<void> {
  await getDb()
    .update(schema.googleCredentials)
    .set({ lastError: message.slice(0, 500) })
    .where(scoped(schema.googleCredentials.organizationId, organizationId));
}

export function secretLast4(secret: string): string {
  return secret.slice(-4);
}

/* Caché del access token, por proceso. Google los emite de una hora. */

type CachedToken = { token: string; expiresAtMs: number };

const globalForGoogle = globalThis as unknown as {
  __googleTokens?: Map<string, CachedToken>;
};

function tokenCache(): Map<string, CachedToken> {
  if (!globalForGoogle.__googleTokens) globalForGoogle.__googleTokens = new Map();
  return globalForGoogle.__googleTokens;
}

export function getCachedGoogleToken(key: string): string | null {
  const hit = tokenCache().get(key);
  if (!hit) return null;
  if (hit.expiresAtMs <= Date.now()) {
    tokenCache().delete(key);
    return null;
  }
  return hit.token;
}

export function setCachedGoogleToken(
  key: string,
  token: string,
  expiresInSeconds: number
): void {
  const ttl = Math.max(30, expiresInSeconds - 60) * 1000;
  tokenCache().set(key, { token, expiresAtMs: Date.now() + ttl });
}

export function clearGoogleTokenCache(): void {
  tokenCache().clear();
}
