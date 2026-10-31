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
export default async function GastosPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const session = await requireSalonPage({ manage: true });
  // Desde Caja llega el periodo que se estaba revisando.
  const { from, to } = await searchParams;
  const isDay = (v?: string): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const initialRange = isDay(from) && isDay(to) && from <= to ? { from, to } : undefined;
  const [{ currency }, timezone] = await Promise.all([
    getBranding(session.organizationId),
    businessTimezone(session.organizationId),
  ]);
  return (
    <NegocioPage title="Gastos">
      <ExpensesClient currency={currency} today={todayInTz(new Date(), timezone)} initialRange={initialRange} />
    </NegocioPage>
  );
}
