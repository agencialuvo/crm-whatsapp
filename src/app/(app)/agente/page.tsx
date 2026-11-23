import { AgentClient } from "@/components/agent/agent-client";
import { canConfigure } from "@/lib/auth/roles";
import { getSessionOrNull } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function AgentPage() {
  // Escribir en «Números que el agente ignora» es de quien configura. El servidor lo exige en la ruta; esto solo
  // decide si se enseñan los controles.
  const session = await getSessionOrNull();
  return <AgentClient canConfigure={canConfigure(session?.role)} />;
}
