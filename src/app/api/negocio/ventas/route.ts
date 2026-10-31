import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { computeFunnel } from "@/lib/salon/funnel";
import { saleInputSchema } from "@/lib/salon/schemas";
import type { CashReportDto } from "@/lib/salon/types";
import { getExpensesTotalCents } from "@/server/business/financial-funnel";
import { periodFromRequest } from "@/server/analytics/period";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { getSalesReport, registerServiceSale } from "@/server/business/sales-service";

export const dynamic = "force-dynamic";

/**
 * Módulo SALON — caja. Con `?from=AAAA-MM-DD&to=AAAA-MM-DD` (días del negocio,
 * inclusivos; sin ellos, los últimos 30) responde el reporte: totales, lo que
 * toca a cada profesional, cuánto entró por método y las ventas. Es dinero, así
 * que es solo del dueño/administrador.
 * Con `?staffId=` todo el reporte (totales, desgloses y ventas) se acota a ese
 * profesional.
 */
export const GET = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  try {
    const period = await periodFromRequest(session.organizationId, new URL(req.url));
    // `?staffId=` acota el reporte a un profesional (auditoría rápida).
    const staffId = new URL(req.url).searchParams.get("staffId")?.slice(0, 64) || null;
    const [report, expensesTotal] = await Promise.all([
      getSalesReport(session.organizationId, period, staffId),
      // Los gastos son del negocio: no se reparten a un profesional.
      staffId ? Promise.resolve(null) : getExpensesTotalCents(session.organizationId, period),
    ]);
    const funnel = computeFunnel({
      count: report.totals.count,
      revenueCents: report.totals.revenueCents,
      commissionsCents: report.totals.commissionsCents,
      expensesCents: expensesTotal,
    });
    const body: CashReportDto = {
      ...report,
      expensesCents: funnel.expensesCents,
      netAfterExpensesCents: funnel.netCents,
    };
    return Response.json(body);
  } catch (err) {
    return salonErrorResponse(err);
  }
});

/**
 * Cobrar: cualquiera del equipo puede registrar una venta en el mostrador, pero
 * dos cosas son del dueño o administrador: fijar una comisión distinta (es lo
 * que se le paga a una persona) y poner la venta en otro día (cambiaría el cierre
 * de caja sin el rastro de auditoría). La pantalla ya no se las ofrece a un
 * miembro; aquí se hace valer porque la API se puede llamar sin la pantalla.
 */
export const POST = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "member");
  if (denied) return denied;
  const body = await parseBody(req, saleInputSchema);
  if (!body.ok) return body.response;
  if (!canConfigure(session.role) && (body.data.customCommissionPercentage != null || body.data.soldOn)) {
    return apiError(
      403,
      "forbidden",
      "Solo el dueño o un administrador puede fijar una comisión distinta o cambiar el día de la venta."
    );
  }
  try {
    const result = await registerServiceSale(session.organizationId, body.data);
    return Response.json(result, { status: 201 });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
