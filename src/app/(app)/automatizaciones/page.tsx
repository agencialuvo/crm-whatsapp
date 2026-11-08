import { AutomationsClient } from "@/components/automatizaciones/automations-client";
import { NegocioPage } from "@/components/negocio/negocio-page";
import { requireAutomationsPage } from "@/server/automation/page-guard";

export const dynamic = "force-dynamic";

/** Automatizaciones — los flujos del negocio: verlos, crearlos y encenderlos. Solo dueño/administrador. */
export default async function AutomatizacionesPage() {
  await requireAutomationsPage();
  return (
    <NegocioPage title="Automatizaciones">
      <AutomationsClient />
    </NegocioPage>
  );
}
