import { LoyaltySettingsClient } from "@/components/settings/loyalty-settings-client";
import { requireSalonPage } from "@/server/business/page-guard";

export const dynamic = "force-dynamic";

/** Ajustes → Fidelización. Solo con la bandera SALON y solo dueño o administrador. */
export default async function LoyaltySettingsPage() {
  await requireSalonPage({ manage: true });
  return <LoyaltySettingsClient />;
}
