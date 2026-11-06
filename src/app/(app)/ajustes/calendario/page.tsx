import { notFound } from "next/navigation";
import { AgendaClient } from "@/components/settings/agenda-client";
import { redirect } from "next/navigation";
import { getSessionOrNull } from "@/lib/auth/session";
import { agendaEnabled } from "@/server/agenda/flag";
import { requirePlanModule } from "@/server/business/page-guard";

export const dynamic = "force-dynamic";

export default async function AgendaSettingsPage() {
  // Sin la bandera esta pantalla no existe en esta instancia.
  if (!agendaEnabled()) notFound();
  const session = await getSessionOrNull();
  if (!session) redirect("/iniciar-sesion");
  await requirePlanModule(session, "agenda");
  return <AgendaClient />;
}
