import { DashboardClient } from "@/components/negocio/dashboard-client";
import { NegocioPage } from "@/components/negocio/negocio-page";
import { todayInTz } from "@/lib/time/slots";
import { businessTimezone } from "@/server/analytics/period";
import { getBranding } from "@/server/branding";
import { requireSalonPage } from "@/server/business/page-guard";

export const dynamic = "force-dynamic";

/**
 * Módulo SALON — panel ejecutivo: cómo va el negocio de un vistazo. Solo
 * dueño/administrador (dinero y datos de clientes). Moneda, zona y «hoy» se
 * resuelven aquí, igual que en Caja.
 */
export default async function PanelPage() {
  const session = await requireSalonPage({ manage: true, module: "finances" });
  const [{ currency }, timezone] = await Promise.all([
    getBranding(session.organizationId),
    businessTimezone(session.organizationId),
  ]);
  return (
    <NegocioPage title="Panel del negocio">
      <DashboardClient
        currency={currency}
        today={todayInTz(new Date(), timezone)}
      />
    </NegocioPage>
  );
}
