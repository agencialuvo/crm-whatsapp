import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { createOtp, OTP_TTL_SECONDS } from "@/server/auth/otp";
import { getBranding } from "@/server/branding";
import { sendMail } from "@/server/email/mailer";
import { loginCodeEmail, twoFactorSetupCodeEmail } from "@/server/email/templates";

/**
 * Verificación en dos pasos (2FA) por correo, opcional por persona
 * (`user.two_factor_enabled`).
 *
 * Cómo se hace valer: el inicio de sesión de Better Auth (`/sign-in/email`) es
 * público, así que el candado va DENTRO de él (hook en `lib/auth`): si la cuenta
 * tiene 2FA, solo pasa cuando la petición viene de `/api/login/two-factor/verify`,
 * que ya comprobó contraseña y código. Ese contexto vive en el proceso
 * (AsyncLocalStorage), no viaja por la red: nadie de fuera puede fabricarlo.
 */

const globalForTwoFactor = globalThis as unknown as {
  __voceroTwoFactorVerified?: AsyncLocalStorage<string>;
};

// En globalThis por la misma razón que el contexto del registro: en dev el módulo
// puede evaluarse más de una vez y todas las copias deben compartir el contexto.
function verifiedContext(): AsyncLocalStorage<string> {
  if (!globalForTwoFactor.__voceroTwoFactorVerified) {
    globalForTwoFactor.__voceroTwoFactorVerified = new AsyncLocalStorage<string>();
  }
  return globalForTwoFactor.__voceroTwoFactorVerified;
}

/** Ejecuta `fn` marcando que `userId` ya pasó la verificación en dos pasos. */
export function runTwoFactorVerified<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return verifiedContext().run(userId, fn);
}

export function isTwoFactorVerified(userId: string): boolean {
  return verifiedContext().getStore() === userId;
}

export type LoginUser = { id: string; name: string; email: string; twoFactorEnabled: boolean };

/** La cuenta por correo (sin distinguir mayúsculas), o `null`. */
export async function findUserByEmail(email: string): Promise<LoginUser | null> {
  const [row] = await getDb()
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      twoFactorEnabled: schema.user.twoFactorEnabled,
    })
    .from(schema.user)
    .where(sql`lower(${schema.user.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);
  return row ?? null;
}

/** Genera el código de acceso y lo manda al correo de la cuenta. Lanza si el correo falla. */
export async function sendLoginCode(user: Pick<LoginUser, "id" | "email">): Promise<void> {
  const code = await createOtp("login-2fa", user.id);
  const branding = await getBranding().catch(() => null);
  const mail = loginCodeEmail({
    code,
    minutes: Math.round(OTP_TTL_SECONDS / 60),
    productName: branding?.name ?? "",
  });
  await sendMail({ to: user.email, ...mail });
}

/** Manda el código de PRUEBA con el que se confirma que el correo llega antes de activar el 2FA. */
export async function sendSetupCode(user: Pick<LoginUser, "id" | "email">): Promise<void> {
  const code = await createOtp("2fa-setup", user.id);
  const branding = await getBranding().catch(() => null);
  const mail = twoFactorSetupCodeEmail({
    code,
    minutes: Math.round(OTP_TTL_SECONDS / 60),
    productName: branding?.name ?? "",
  });
  await sendMail({ to: user.email, ...mail });
}

/* ------------------------------ códigos de respaldo ------------------------------ */

/** Cuántos códigos de respaldo se dan al activar el 2FA. */
export const BACKUP_CODE_COUNT = 5;
/** Sin 0/O, 1/I/L: se leen y se copian a mano sin confundirse. */
const BACKUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const BACKUP_LENGTH = 8;

/** `abcd-ef12` → `ABCDEF12`: se acepta con guion, con espacios y en minúsculas. */
export function normalizeBackupCode(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function hashBackupCode(userId: string, code: string): string {
  return createHmac("sha256", getEnv().BETTER_AUTH_SECRET).update(`backup:${userId}:${code}`).digest("hex");
}

/** Códigos nuevos en claro (para mostrarlos UNA vez) y sus hashes (lo único que se guarda). */
function newBackupCodes(userId: string): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const raw = Array.from({ length: BACKUP_LENGTH }, () => BACKUP_ALPHABET.charAt(randomInt(BACKUP_ALPHABET.length))).join("");
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
  return { plain, hashes: plain.map((c) => hashBackupCode(userId, normalizeBackupCode(c))) };
}

function parseHashes(stored: string | null): string[] {
  if (!stored) return [];
  try {
    const v = JSON.parse(stored) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Cuántos códigos de respaldo le quedan sin usar. */
export async function backupCodesRemaining(userId: string): Promise<number> {
  const [row] = await getDb()
    .select({ codes: schema.user.twoFactorBackupCodes })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return parseHashes(row?.codes ?? null).length;
}

/**
 * Termina la activación (el código de prueba ya se comprobó): enciende el 2FA y
 * guarda los códigos de respaldo en un solo UPDATE. Devuelve los códigos en claro.
 */
export async function activateTwoFactor(userId: string): Promise<string[]> {
  const { plain, hashes } = newBackupCodes(userId);
  await getDb()
    .update(schema.user)
    .set({ twoFactorEnabled: true, twoFactorBackupCodes: JSON.stringify(hashes), updatedAt: new Date() })
    .where(eq(schema.user.id, userId));
  return plain;
}

/** Códigos de respaldo nuevos: los anteriores dejan de valer. Solo con el 2FA activo. */
export async function regenerateBackupCodes(userId: string): Promise<string[] | null> {
  const { plain, hashes } = newBackupCodes(userId);
  const rows = await getDb()
    .update(schema.user)
    .set({ twoFactorBackupCodes: JSON.stringify(hashes), updatedAt: new Date() })
    .where(and(eq(schema.user.id, userId), eq(schema.user.twoFactorEnabled, true)))
    .returning({ id: schema.user.id });
  return rows.length > 0 ? plain : null;
}

/**
 * Gasta un código de respaldo. El UPDATE lleva la lista que se leyó en su WHERE: si
 * otra petición ya gastó uno, no actualiza nada y se reintenta; así un mismo código
 * no entra dos veces aunque lleguen dos peticiones a la vez.
 */
export async function consumeBackupCode(userId: string, raw: string): Promise<boolean> {
  const code = normalizeBackupCode(raw);
  if (code.length !== BACKUP_LENGTH) return false;
  const given = Buffer.from(hashBackupCode(userId, code));
  const db = getDb();
  for (let attempt = 0; attempt < 3; attempt++) {
    const [row] = await db
      .select({ codes: schema.user.twoFactorBackupCodes })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .limit(1);
    if (!row?.codes) return false;
    const hashes = parseHashes(row.codes);
    const index = hashes.findIndex((h) => {
      const wanted = Buffer.from(h);
      return wanted.length === given.length && timingSafeEqual(wanted, given);
    });
    if (index < 0) return false;
    const left = hashes.filter((_, i) => i !== index);
    const done = await db
      .update(schema.user)
      .set({ twoFactorBackupCodes: JSON.stringify(left), updatedAt: new Date() })
      .where(and(eq(schema.user.id, userId), eq(schema.user.twoFactorBackupCodes, row.codes)))
      .returning({ id: schema.user.id });
    if (done.length > 0) return true;
  }
  return false;
}

/** Apaga el 2FA y borra sus códigos de respaldo. (Encenderlo pasa por `activateTwoFactor`.) */
export async function disableTwoFactor(userId: string): Promise<void> {
  await getDb()
    .update(schema.user)
    .set({ twoFactorEnabled: false, twoFactorBackupCodes: null, updatedAt: new Date() })
    .where(eq(schema.user.id, userId));
}

export async function isTwoFactorEnabled(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ on: schema.user.twoFactorEnabled })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return row?.on === true;
}
