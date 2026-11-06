import { parseBody, withAuth } from "@/lib/api";
import { saleDatePatchSchema, saleEditSchema } from "@/lib/salon/schemas";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { deleteSale, updateSale, updateSaleDate } from "@/server/business/sales-service";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Corregir la fecha de una venta registrada con un día equivocado. Solo
 * dueño/administrador. Cada cambio queda auditado (quién, cuándo, fecha anterior).
 */
export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "finances");
  if (planBlocked) return planBlocked;
  const body = await parseBody(req, saleDatePatchSchema);
  if (!body.ok) return body.response;
  const { id } = await ctx.params;
  try {
    return Response.json(await updateSaleDate(session.organizationId, id, body.data.soldOn, session.userId));
  } catch (err) {
    return salonErrorResponse(err);
  }
});

/**
 * Corregir una venta: ítems, profesional y monto. Solo dueño/administrador.
 * Todo cambio queda auditado (la venta antes y después, quién y cuándo).
 */
export const PUT = withAuth(async (session, req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "finances");
  if (planBlocked) return planBlocked;
  const body = await parseBody(req, saleEditSchema);
  if (!body.ok) return body.response;
  const { id } = await ctx.params;
  try {
    return Response.json(await updateSale(session.organizationId, id, body.data, session.userId));
  } catch (err) {
    return salonErrorResponse(err);
  }
});

/** Anular una venta mal registrada. Solo dueño/administrador. */
export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "finances");
  if (planBlocked) return planBlocked;
  const { id } = await ctx.params;
  try {
    await deleteSale(session.organizationId, id);
    return Response.json({ ok: true });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
