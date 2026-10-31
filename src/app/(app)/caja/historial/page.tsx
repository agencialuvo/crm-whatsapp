import { NegocioPage } from "@/components/negocio/negocio-page";
import { ShiftHistoryClient } from "@/components/negocio/shift-history-client";
import { todayInTz } from "@/lib/time/slots";
import { businessTimezone } from "@/server/analytics/period";
import { getBranding } from "@/server/branding";
import { requireSalonPage } from "@/server/business/page-guard";

export const dynamic = "force-dynamic";

/**
 * Módulo SALON — historial de turnos de caja cerrados. Solo dueño/administrador: es dinero.
 * Moneda, zona y «hoy» se resuelven aquí y bajan como props, igual que en Caja.
 */
export default async function HistorialDeTurnosPage() {
  const session = await requireSalonPage({ manage: true });
  const [{ currency }, timezone] = await Promise.all([
    getBranding(session.organizationId),
    businessTimezone(session.organizationId),
  ]);
  return (
    <NegocioPage title="Historial de turnos">
      <ShiftHistoryClient currency={currency} timezone={timezone} today={todayInTz(new Date(), timezone)} />
    </NegocioPage>
  );
}
