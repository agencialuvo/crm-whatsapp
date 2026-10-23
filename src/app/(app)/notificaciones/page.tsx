import { redirect } from "next/navigation";
import { NegocioPage } from "@/components/negocio/negocio-page";
import { NotificationsClient } from "@/components/notifications/notifications-client";
import { getSessionOrNull } from "@/lib/auth/session";
import { businessTimezone } from "@/server/analytics/period";

export const dynamic = "force-dynamic";

/** Las notificaciones del equipo: citas, ventas y contactos nuevos, con filtros. */
export default async function NotificacionesPage() {
  const session = await getSessionOrNull();
  if (!session) redirect("/iniciar-sesion");
  const timezone = await businessTimezone(session.organizationId);
  return (
    <NegocioPage title="Notificaciones">
      <NotificationsClient timezone={timezone} />
    </NegocioPage>
  );
}
