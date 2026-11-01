import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { getEnv } from "@/lib/env";

/**
 * Códigos de un solo uso (OTP) de 6 dígitos, guardados en la tabla `verification`
 * de Better Auth. Un código por persona y propósito: pedir uno nuevo invalida el
 * anterior. Solo se guarda su HMAC (con el secreto de la instancia), nunca el
 * código; vence, se gasta al usarse y se bloquea tras unos intentos fallidos.
 */

export const OTP_TTL_SECONDS = 10 * 60;
export const OTP_LENGTH = 6;
export const OTP_MAX_ATTEMPTS = 5;

/** Para qué sirve el código: dos propósitos no se confunden aunque el código coincida. */
export type OtpPurpose = "password-change" | "login-2fa" | "2fa-setup" | "signup-verify";

export type OtpResult = "ok" | "invalid" | "expired" | "too_many" | "missing";

const identifierOf = (purpose: OtpPurpose, userId: string) => `${purpose}:${userId}`;

function hashCode(purpose: OtpPurpose, userId: string, code: string): string {
  return createHmac("sha256", getEnv().BETTER_AUTH_SECRET).update(`${purpose}:${userId}:${code}`).digest("hex");
}

/** Genera un código nuevo (el anterior deja de valer), lo guarda hasheado y lo devuelve para enviarlo. */
export async function createOtp(purpose: OtpPurpose, userId: string): Promise<string> {
  const db = getDb();
  const code = String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
  const identifier = identifierOf(purpose, userId);
  await db.delete(schema.verification).where(eq(schema.verification.identifier, identifier));
  await db.insert(schema.verification).values({
    id: `otp_${identifier}`,
    identifier,
    value: JSON.stringify({ h: hashCode(purpose, userId, code), a: 0 }),
    expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
  });
  return code;
}

/** Comprueba el código y, si es el correcto, lo gasta. Los intentos fallidos se cuentan. */
export async function consumeOtp(purpose: OtpPurpose, userId: string, code: string): Promise<OtpResult> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.verification)
    .where(eq(schema.verification.identifier, identifierOf(purpose, userId)))
    .limit(1);
  if (!row) return "missing";
  const drop = () => db.delete(schema.verification).where(eq(schema.verification.id, row.id));
  if (row.expiresAt.getTime() < Date.now()) {
    await drop();
    return "expired";
  }
  let stored: { h: string; a: number };
  try {
    stored = JSON.parse(row.value) as { h: string; a: number };
  } catch {
    await drop();
    return "missing";
  }
  if (stored.a >= OTP_MAX_ATTEMPTS) {
    await drop();
    return "too_many";
  }
  // El intento se cuenta ANTES de comparar y de forma atómica (compare-and-swap sobre el valor
  // leído): varias peticiones en paralelo no pueden adivinar más veces que el tope.
  const counted = await db
    .update(schema.verification)
    .set({ value: JSON.stringify({ h: stored.h, a: stored.a + 1 }), updatedAt: new Date() })
    .where(and(eq(schema.verification.id, row.id), eq(schema.verification.value, row.value)))
    .returning({ id: schema.verification.id });
  if (counted.length === 0) return "invalid";
  const given = Buffer.from(hashCode(purpose, userId, code));
  const wanted = Buffer.from(stored.h);
  if (given.length === wanted.length && timingSafeEqual(given, wanted)) {
    // Gastarlo también es atómico: dos peticiones con el mismo código correcto no pasan ambas.
    const spent = await db
      .delete(schema.verification)
      .where(eq(schema.verification.id, row.id))
      .returning({ id: schema.verification.id });
    return spent.length > 0 ? "ok" : "missing";
  }
  return stored.a + 1 >= OTP_MAX_ATTEMPTS ? "too_many" : "invalid";
}
