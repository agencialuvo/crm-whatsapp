import { parseBody, withAuth } from "@/lib/api";
import { expenseItemInputSchema } from "@/lib/salon/expenses";
import { periodFromRequest } from "@/server/analytics/period";
import { createExpense, getExpensesReport } from "@/server/business/expenses";
import { salonErrorResponse, salonGate } from "@/server/business/http";

export const dynamic = "force-dynamic";

/**
 * Módulo SALON — egresos y gastos operativos. Solo dueño/administrador (es dinero).
 * Con `?from=AAAA-MM-DD&to=AAAA-MM-DD` (días del negocio, inclusivos; sin ellos,
 * los últimos 30) responde los gastos del periodo y el comparativo: ingresos,
 * comisiones, gastos y ganancia neta real. `?kind=fixed|variable` acota la tabla.
 */
export const GET = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  try {
    const url = new URL(req.url);
    const period = await periodFromRequest(session.organizationId, url);
    return Response.json(
      await getExpensesReport(session.organizationId, period, {
        kind: (["fixed", "variable"] as const).find((k) => k === url.searchParams.get("kind")) ?? null,
      })
    );
  } catch (err) {
    return salonErrorResponse(err);
  }
});

/** Registrar un gasto (fijo o insumo; el precio es lo pagado). */
export const POST = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const body = await parseBody(req, expenseItemInputSchema);
  if (!body.ok) return body.response;
  try {
    return Response.json(await createExpense(session.organizationId, body.data), { status: 201 });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
