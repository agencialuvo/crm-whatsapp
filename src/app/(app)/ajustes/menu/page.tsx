import { notFound } from "next/navigation";
import { MenuSettingsClient } from "@/components/settings/menu-settings-client";
import { canConfigure } from "@/lib/auth/roles";
import { getSessionOrNull } from "@/lib/auth/session";
import { suggestedTemplateKey } from "@/lib/menu-config";
import { getActiveMenu, listMenuTemplates } from "@/server/business/menu-config";
import { navFlags } from "@/server/business/nav-flags";
import { getSectorSetup } from "@/server/business/sector-setup";

export const dynamic = "force-dynamic";

/**
 * Ajustes → Menú. Solo propietario o administrador. Personaliza el menú lateral de TODO el equipo: orden, qué se ve,
 * nombres e iconos, con plantillas base del sistema (solo lectura) y plantillas guardadas de la organización. Ocultar
 * una entrada solo la quita de la barra: la pantalla, sus datos y su ruta siguen donde estaban.
 */
export default async function MenuSettingsPage() {
  const session = await getSessionOrNull();
  if (!session || !canConfigure(session.role)) notFound();
  const [active, templates, setup] = await Promise.all([
    getActiveMenu(session.organizationId),
    listMenuTemplates(session.organizationId),
    getSectorSetup(session.organizationId).catch(() => null),
  ]);
  return (
    <div className="max-w-3xl">
      <MenuSettingsClient
        {...navFlags()}
        role={session.role}
        activeConfig={active?.config ?? null}
        activeBaseKey={active?.baseKey ?? null}
        templates={templates}
        suggestedKey={suggestedTemplateKey(setup?.categoryKey)}
      />
    </div>
  );
}
