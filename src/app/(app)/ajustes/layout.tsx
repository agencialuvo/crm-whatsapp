import { canConfigure } from "@/lib/auth/roles";
import { getSessionOrNull } from "@/lib/auth/session";
import { getSectorSetup } from "@/server/business/sector-setup";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { SettingsNav } from "@/components/settings/settings-nav";
import { agendaEnabled } from "@/server/agenda/flag";
import { atribucionEnabled } from "@/server/attribution/flag";
import { salonEnabled } from "@/server/business/flag";
import { isChannelEnabled } from "@/server/channels/enabled";
import { SETTINGS_SCROLL_ID } from "@/lib/settings-scroll";

// La bandera se lee en cada petición: si esto se resolviera al construir, la
// imagen quedaría con la agenda apagada para siempre y encenderla en la
// plataforma no haría nada.
export const dynamic = "force-dynamic";

export default async function SettingsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // «Tipo de negocio» solo para quien puede cambiarlo y si el negocio tiene perfil de sector.
  const session = await getSessionOrNull();
  const sector =
    !!session &&
    canConfigure(session.role) &&
    (await getSectorSetup(session.organizationId).catch(() => null)) !== null;
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-6 sm:py-4">
        <h2 className="text-[17px] font-bold tracking-tight">Configuración</h2>
        <NotificationBell />
      </header>
      {/* En móvil las pestañas van arriba (en fila), no como columna lateral. */}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <SettingsNav
          agenda={agendaEnabled()}
          atribucion={atribucionEnabled()}
          instagram={isChannelEnabled("instagram")}
          messenger={isChannelEnabled("messenger")}
          tiktok={isChannelEnabled("tiktok")}
          salon={salonEnabled()}
          sector={sector}
        />
        <div id={SETTINGS_SCROLL_ID} className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {children}
        </div>
      </div>
    </div>
  );
}
