import { and, eq } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { getDb, schema } from "@/lib/db";
import { consumeOtp, createOtp, OTP_TTL_SECONDS, type OtpResult } from "@/server/auth/otp";
import { getBranding } from "@/server/branding";
import { passwordResetAvailable } from "@/server/email/config";
import { sendMail } from "@/server/email/mailer";
import { passwordChangeCodeEmail, passwordChangedAlertEmail } from "@/server/email/templates";

/**
 * Cambiar la contraseña desde Mi perfil, con doble verificación: la contraseña
 * actual Y un código de un solo uso que llega al correo de la cuenta. Así una
 * sesión desatendida en el mostrador no alcanza para tomar la cuenta.
 *
 * Sin servidor de correo (producción sin SMTP) no hay a dónde mandar el código:
 * el cambio pide solo la contraseña actual (degradación, constitución II).
 */

export type ChangeCodeResult = OtpResult;

/** ¿Se puede mandar el código por correo en esta instancia? */
export function changeCodeAvailable(): boolean {
  return passwordResetAvailable();
}

/** ¿Es esta la contraseña actual de la cuenta (la de correo y contraseña)? */
export async function verifyCurrentPassword(userId: string, password: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ hash: schema.account.password })
    .from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "credential")))
    .limit(1);
  if (!row?.hash) return false;
  return verifyPassword({ hash: row.hash, password });
}

/** Genera un código nuevo (el anterior deja de valer) y lo manda por correo. */
export async function issueChangeCode(userId: string, email: string): Promise<void> {
  const code = await createOtp("password-change", userId);
  const branding = await getBranding().catch(() => null);
  const mail = passwordChangeCodeEmail({
    code,
    minutes: Math.round(OTP_TTL_SECONDS / 60),
    productName: branding?.name ?? "",
  });
  await sendMail({ to: email, ...mail });
}

/** Comprueba el código y, si es el correcto, lo gasta. */
export function consumeChangeCode(userId: string, code: string): Promise<ChangeCodeResult> {
  return consumeOtp("password-change", userId, code);
}

/**
 * Aviso de seguridad inmediato: a la propia persona y a los propietarios de la
 * organización. Mejor esfuerzo: un correo caído nunca deshace el cambio.
 */
export async function notifyPasswordChanged(input: {
  organizationId: string;
  user: { name: string; email: string };
}): Promise<void> {
  const db = getDb();
  const owners = await db
    .select({ email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, input.organizationId), eq(schema.member.role, "owner")));
  const recipients = [...new Set([input.user.email, ...owners.map((o) => o.email)].map((e) => e.toLowerCase()))];

  const branding = await getBranding(input.organizationId).catch(() => null);
  const mail = passwordChangedAlertEmail({
    userName: input.user.name,
    userEmail: input.user.email,
    when: `${new Date().toISOString().slice(0, 16).replace("T", " ")} (UTC)`,
    productName: branding?.name ?? "",
  });
  await Promise.all(
    recipients.map((to) =>
      sendMail({ to, ...mail }).catch((err) =>
        console.error(
          "[auth] no se pudo enviar el aviso de cambio de contraseña:",
          err instanceof Error ? err.message : "error"
        )
      )
    )
  );
}
