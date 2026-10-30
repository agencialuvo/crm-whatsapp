import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ProfileClient } from "@/components/settings/profile-client";
import { getAuth } from "@/lib/auth";
import { backupCodesRemaining, isTwoFactorEnabled } from "@/server/auth/two-factor";
import { consoleMailerAllowed, emailConfigured } from "@/server/email/config";

export const dynamic = "force-dynamic";

/** Ajustes → Mi perfil. Es de quien inició sesión, sea cual sea su rol. */
export default async function ProfilePage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/iniciar-sesion");
  const { name, email, image } = session.user;
  // Cómo viaja el código del cambio de contraseña: lo decide el servidor.
  const emailMode = emailConfigured() ? "smtp" : consoleMailerAllowed() ? "console" : "off";
  const twoFactorEnabled = await isTwoFactorEnabled(session.user.id);
  return (
    <ProfileClient
      name={name}
      email={email}
      image={image ?? null}
      emailMode={emailMode}
      twoFactorEnabled={twoFactorEnabled}
      backupCodesRemaining={await backupCodesRemaining(session.user.id)}
    />
  );
}
