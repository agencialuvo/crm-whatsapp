import { ExpensesClient } from "@/components/negocio/expenses-client";
import { NegocioPage } from "@/components/negocio/negocio-page";
import { todayInTz } from "@/lib/time/slots";
import { businessTimezone } from "@/server/analytics/period";
import { getBranding } from "@/server/branding";
import { requireSalonPage } from "@/server/business/page-guard";

export const dynamic = "force-dynamic";

/**
 * Módulo SALON — egresos y gastos operativos. Solo dueño/administrador: es dinero.
 * Moneda y «hoy» se resuelven aquí, en la zona del negocio, y bajan como props.
 */
export default async function GastosPage() {
  const session = await requireSalonPage({ manage: true });
  const [{ currency }, timezone] = await Promise.all([
    getBranding(session.organizationId),
    businessTimezone(session.organizationId),
  ]);
  return (
    <NegocioPage title="Gastos">
      <ExpensesClient currency={currency} today={todayInTz(new Date(), timezone)} />
    </NegocioPage>
  );
}
