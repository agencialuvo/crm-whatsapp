import { redirect } from "next/navigation";
import { MediosClient } from "@/components/medios/medios-client";
import { NegocioPage } from "@/components/negocio/negocio-page";
import { getSessionOrNull } from "@/lib/auth/session";
import { videoOptimizeEnabled } from "@/server/medios/flag";

export const dynamic = "force-dynamic";

/** Módulo Medios — la biblioteca de imágenes y videos del negocio. */
export default async function MediosPage() {
  const session = await getSessionOrNull();
  if (!session) redirect("/iniciar-sesion");
  return (
    <NegocioPage title="Medios">
      <MediosClient optimizarVideo={videoOptimizeEnabled()} />
    </NegocioPage>
  );
}
