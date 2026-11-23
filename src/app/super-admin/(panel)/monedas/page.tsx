import { CreditsPanel } from "@/components/super-admin/credits-panel";

export const dynamic = "force-dynamic";

/** Monedas (Super Admin): calibración del modo sombra y operación por organización. El gate vive en el layout del panel. */
export default function SuperAdminCreditsPage() {
  return <CreditsPanel />;
}
