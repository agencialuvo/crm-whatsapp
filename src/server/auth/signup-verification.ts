import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { createOtp, OTP_TTL_SECONDS } from "@/server/auth/otp";
import { onOwnerRegistered } from "@/server/auth/on-signup";
import { verifyCurrentPassword } from "@/server/auth/password-change";
import { getBranding } from "@/server/branding";
import { sendMail } from "@/server/email/mailer";
import { signupCodeEmail } from "@/server/email/templates";

/**
 * Verificación del correo al registrarse (registro público de propietarios).
 *
 * La cuenta nace SIN sesión y SIN negocio: hasta que se escribe el código que llegó al correo, no puede
 * entrar a nada. Con el código correcto se marca el correo como verificado, se crea SU negocio
 * (`onOwnerRegistered`) y recién entonces se inicia la sesión (desde el servidor, en `/api/registro/verificar`).
 */

export type PendingSignup = { id: string; name: string; email: string };

/** ¿Tiene la cuenta algún negocio? Las de equipo y las creadas por backend lo tienen desde el primer momento. */
async function hasMembership(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(eq(schema.member.userId, userId))
    .limit(1);
  return Boolean(row);
}

/** La cuenta de ese correo si sigue SIN verificar y sin negocio (un registro a medias); si no, `null`. */
export async function findPendingSignup(email: string): Promise<PendingSignup | null> {
  const [row] = await getDb()
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      verified: schema.user.emailVerified,
    })
    .from(schema.user)
    .where(sql`lower(${schema.user.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);
  if (!row || row.verified || (await hasMembership(row.id))) return null;
  return { id: row.id, name: row.name, email: row.email };
}

/** Un registro a medias CON la contraseña correcta (el código solo se manda y se canjea con ella). */
export async function findPendingSignupWithPassword(email: string, password: string): Promise<PendingSignup | null> {
  const pending = await findPendingSignup(email);
  if (!pending || !(await verifyCurrentPassword(pending.id, password))) return null;
  return pending;
}

/** Genera el código y lo manda al correo de la cuenta. Lanza si el correo falla. */
export async function sendSignupCode(user: Pick<PendingSignup, "id" | "email">): Promise<void> {
  const code = await createOtp("signup-verify", user.id);
  const branding = await getBranding().catch(() => null);
  const mail = signupCodeEmail({
    code,
    minutes: Math.round(OTP_TTL_SECONDS / 60),
    productName: branding?.name ?? "",
  });
  await sendMail({ to: user.email, ...mail });
}

/**
 * Cierra el registro con el código ya canjeado: verifica el correo y crea el negocio del propietario.
 * Idempotente: si ya tiene negocio no crea otro.
 */
export async function completeSignup(user: PendingSignup): Promise<void> {
  await getDb()
    .update(schema.user)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(schema.user.id, user.id));
  if (!(await hasMembership(user.id))) await onOwnerRegistered(user.id, user.name);
}
