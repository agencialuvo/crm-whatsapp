import { FlowDetailClient } from "@/components/automatizaciones/flow-detail-client";
import { NegocioPage } from "@/components/negocio/negocio-page";
import { requireAutomationsPage } from "@/server/automation/page-guard";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Automatizaciones — un flujo: su disparador, sus reglas y sus pasos. Solo dueño/administrador. */
export default async function AutomatizacionPage({ params }: Params) {
  await requireAutomationsPage();
  const { id } = await params;
  return (
    <NegocioPage title="Automatización">
      <FlowDetailClient flowId={id} />
    </NegocioPage>
  );
}
