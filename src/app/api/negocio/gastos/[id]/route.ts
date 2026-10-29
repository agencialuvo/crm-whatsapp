import { parseBody, withAuth } from "@/lib/api";
import { expenseItemInputSchema } from "@/lib/salon/expenses";
import { deleteExpense, updateExpense } from "@/server/business/expenses";
import { salonErrorResponse, salonGate } from "@/server/business/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Corregir un gasto (reemplaza todos sus campos). Solo dueño/administrador. */
export const PUT = withAuth(async (session, req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const body = await parseBody(req, expenseItemInputSchema);
  if (!body.ok) return body.response;
  const { id } = await ctx.params;
  try {
    await updateExpense(session.organizationId, id, body.data);
    return Response.json({ ok: true });
  } catch (err) {
    return salonErrorResponse(err);
  }
});

/** Borrar un gasto. Solo dueño/administrador. */
export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    await deleteExpense(session.organizationId, id);
    return Response.json({ ok: true });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
