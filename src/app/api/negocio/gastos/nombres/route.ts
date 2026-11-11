import { z } from "zod";
import { parseBody, withAuth } from "@/lib/api";
import { hideExpenseName, listExpenseNames } from "@/server/business/expenses";
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

const hideSchema = z.object({
  kind: z.enum(["fixed", "variable"]),
  name: z.string().trim().min(1, "Escribe el nombre a ocultar").max(120),
});

/**
 * Oculta un nombre de las sugerencias (no borra ningún gasto). Solo dueño/administrador.
 * Cuerpo: `{ kind: "fixed" | "variable", name }`.
 */
export const DELETE = withAuth(async (session, req: Request) => {
  const denied = salonGate(session, "manager");
  if (denied) return denied;
  const planBlocked = await moduleGate(session.organizationId, "finances");
  if (planBlocked) return planBlocked;
  const body = await parseBody(req, hideSchema);
  if (!body.ok) return body.response;
  try {
    await hideExpenseName(session.organizationId, body.data.kind, body.data.name);
    return Response.json({ ok: true });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
