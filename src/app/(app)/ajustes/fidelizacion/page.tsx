import { LoyaltySettingsClient } from "@/components/settings/loyalty-settings-client";
import { getBranding } from "@/server/branding";
import { requireSalonPage } from "@/server/business/page-guard";

export const dynamic = "force-dynamic";

/** Ajustes → Marketing → Tarjeta de fidelización. Solo con la bandera SALON y solo dueño o administrador. */
export default async function LoyaltySettingsPage() {
  const session = await requireSalonPage({ manage: true });
  const { currency } = await getBranding(session.organizationId);
  return <LoyaltySettingsClient currency={currency} />;
}
