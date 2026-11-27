import { TemplatesClient } from "@/components/settings/templates-client";
import { canConfigure } from "@/lib/auth/roles";
import { getSessionOrNull } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function TemplatesSettingsPage() {
  const session = await getSessionOrNull();
  // Borrar es irreversible (y Meta bloquea el nombre 30 días): solo dueño o administrador ven el botón.
  return <TemplatesClient canDelete={!!session && canConfigure(session.role)} />;
}
