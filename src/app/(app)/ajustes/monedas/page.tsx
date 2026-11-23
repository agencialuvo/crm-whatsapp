import { notFound, redirect } from "next/navigation";
import { CreditsCard } from "@/components/credits/credits-card";
import { canConfigure } from "@/lib/auth/roles";
import { getSessionOrNull } from "@/lib/auth/session";
import { creditSummary, creditsEnabled } from "@/server/saas/credits-summary";

export const dynamic = "force-dynamic";

/**
 * Ajustes → Monedas. Solo existe con `CREDITS` encendida (apagada: 404) y solo para quien configura el negocio.
 * Funciona igual con y sin `NEXT_PUBLIC_NAV_V2`: Ajustes tiene su propia navegación lateral.
 */
export default async function MonedasPage() {
  if (!creditsEnabled()) notFound();
  const session = await getSessionOrNull();
  if (!session) redirect("/iniciar-sesion");
  if (!canConfigure(session.role)) notFound();
  const summary = await creditSummary(session.organizationId);
  if (!summary.enabled) notFound();
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <CreditsCard summary={summary} />
    </div>
  );
}
