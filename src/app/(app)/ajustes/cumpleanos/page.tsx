import { BirthdayCampaignClient } from "@/components/settings/birthday-campaign-client";
import { getBranding } from "@/server/branding";
import { requireSalonPage } from "@/server/business/page-guard";

export const dynamic = "force-dynamic";

/** Ajustes → Marketing → Campaña de cumpleaños. Solo con la bandera SALON y solo dueño o administrador. */
export default async function BirthdayCampaignPage() {
  const session = await requireSalonPage({ manage: true });
  const { currency } = await getBranding(session.organizationId);
  return <BirthdayCampaignClient currency={currency} />;
}
