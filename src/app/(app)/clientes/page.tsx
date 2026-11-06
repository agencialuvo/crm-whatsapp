import { ClientsClient } from "@/components/negocio/clients-client";
import { NegocioPage } from "@/components/negocio/negocio-page";
import { todayInTz } from "@/lib/time/slots";
import { businessTimezone } from "@/server/analytics/period";
import { getBranding } from "@/server/branding";
import { requireSalonPage } from "@/server/business/page-guard";

export const dynamic = "force-dynamic";

/**
 * Módulo SALON — clientes: los contactos que ya compraron en Caja. Solo
 * dueño/administrador (muestra lo que cada cliente ha gastado).
 */
export default async function ClientesPage() {
  const session = await requireSalonPage({ manage: true, module: "salon" });
  const [{ currency }, timezone] = await Promise.all([
    getBranding(session.organizationId),
    businessTimezone(session.organizationId),
  ]);
  return (
    <NegocioPage title="Clientes">
      <ClientsClient
        currency={currency}
        timezone={timezone}
        today={todayInTz(new Date(), timezone)}
      />
    </NegocioPage>
  );
}
