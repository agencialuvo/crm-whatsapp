import { withAuth } from "@/lib/api";
import { listExpenseNames } from "@/server/business/expenses";
import { salonErrorResponse, salonGate } from "@/server/business/http";
import { moduleGate } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

/** Nombres ya usados en gastos del mismo tipo (`?kind=fixed|variable`), para autocompletar. Solo dueño/administrador. */
export const GET = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "finances");
  if (planBlocked) return planBlocked;
  try {
    const kind = new URL(req.url).searchParams.get("kind") === "fixed" ? "fixed" : "variable";
    const rows = await listExpenseNames(session.organizationId, kind);
    return Response.json({
      names: rows.map((r) => r.name),
      // Unidades por paquete de la última compra de cada nombre (para autocompletar).
      packSizes: Object.fromEntries(
        rows.filter((r) => r.unitsPerPackage).map((r) => [r.name.toLowerCase(), r.unitsPerPackage])
      ),
    });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
