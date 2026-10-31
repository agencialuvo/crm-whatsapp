import { CatalogClient } from "@/components/negocio/catalog-client";
import { NegocioPage } from "@/components/negocio/negocio-page";
import { getBranding } from "@/server/branding";
import { requireSalonPage } from "@/server/business/page-guard";

// Las banderas se leen en cada petición: resueltas al construir, encenderlas en
// la plataforma no haría nada.
export const dynamic = "force-dynamic";

/** Módulo SALON — servicios regulares y ofertas de publicidad. Solo dueño/administrador. */
export default async function ServiciosPage() {
  const session = await requireSalonPage({ manage: true });
  const { currency } = await getBranding(session.organizationId);
  return (
    <NegocioPage title="Servicios">
      <CatalogClient currency={currency} />
    </NegocioPage>
  );
}
