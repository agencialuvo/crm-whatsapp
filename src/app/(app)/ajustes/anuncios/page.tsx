import { notFound } from "next/navigation";
import { AdFlowsClient } from "@/components/settings/ad-flows-client";
import { AdsClient } from "@/components/settings/ads-client";
import { atribucionEnabled } from "@/server/attribution/flag";

export const dynamic = "force-dynamic";

export default function AdsSettingsPage() {
  // Sin la bandera esta pantalla no existe en esta instancia.
  if (!atribucionEnabled()) notFound();
  return (
    <div className="max-w-3xl space-y-6">
      <AdsClient />
      <AdFlowsClient />
    </div>
  );
}
