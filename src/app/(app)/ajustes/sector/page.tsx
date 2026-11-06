import { notFound } from "next/navigation";
import { SectorSettingsClient } from "@/components/settings/sector-settings-client";
import { canConfigure } from "@/lib/auth/roles";
import { getSessionOrNull } from "@/lib/auth/session";
import { getSectorSetup, listBusinessSectors } from "@/server/business/sector-setup";

export const dynamic = "force-dynamic";

/** Ajustes → Tipo de negocio. Solo propietario o administrador, y solo negocios con perfil de sector (módulo SaaS). */
export default async function SectorSettingsPage() {
  const session = await getSessionOrNull();
  if (!session || !canConfigure(session.role)) notFound();
  const setup = await getSectorSetup(session.organizationId);
  if (!setup) notFound();
  const sectors = await listBusinessSectors();
  return (
    <div className="max-w-2xl">
      <SectorSettingsClient sectors={sectors} currentKey={setup.categoryKey} />
    </div>
  );
}
