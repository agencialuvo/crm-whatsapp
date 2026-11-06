import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Caja — lo que un miembro del equipo NO puede hacer al cobrar por la API:
 * fijar una comisión distinta (lo que se le paga a alguien) ni poner la venta en
 * otro día (movería el cierre sin auditoría). La pantalla ya no se lo ofrece;
 * aquí se prueba que la API lo hace valer sin la pantalla.
 */
const session = vi.hoisted(() => ({ role: "member", organizationId: "org_a", userId: "usr_1" }));
const registrar = vi.hoisted(() => vi.fn());
// El candado por plan consulta la BD: esta prueba es de otra cosa (roles), así que lo deja pasar.
vi.mock("@/server/business/saas-guard", () => ({ moduleGate: async () => null, getPlanAccess: async () => ({ unrestricted: true, modules: [], planName: "test" }) }));

vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ ...session }),
  getSessionOrNull: async () => ({ ...session }),
}));
vi.mock("@/server/business/flag", () => ({
  salonEnabled: () => true,
  salonDisabledResponse: () => new Response(null, { status: 404 }),
}));
vi.mock("@/server/business/sales-service", () => ({
  registerServiceSale: registrar,
  getSalesReport: vi.fn(),
}));
vi.mock("@/server/analytics/period", () => ({ periodFromRequest: vi.fn() }));

import { POST } from "@/app/api/negocio/ventas/route";

const venta = {
  staffId: "stf_1",
  items: [{ serviceId: "srv_1" }],
  amountCents: 3000,
  paymentMethod: "efectivo",
};

function post(body: object) {
  return POST(
    new Request("http://localhost/api/negocio/ventas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  registrar.mockReset();
  registrar.mockResolvedValue({ sale: { id: "ss_1" } });
});

describe("POST /api/negocio/ventas por rol", () => {
  it("un miembro cobra una venta normal", async () => {
    session.role = "member";
    expect((await post(venta)).status).toBe(201);
    expect(registrar).toHaveBeenCalledOnce();
  });

  it("un miembro no puede fijar una comisión distinta ni cambiar el día: 403 sin tocar nada", async () => {
    session.role = "member";
    for (const extra of [{ customCommissionPercentage: 90 }, { customCommissionPercentage: 0 }, { soldOn: "2026-01-01" }]) {
      expect((await post({ ...venta, ...extra })).status, JSON.stringify(extra)).toBe(403);
    }
    expect(registrar).not.toHaveBeenCalled();
  });

  it("dueño y administrador sí pueden", async () => {
    for (const role of ["owner", "admin"]) {
      session.role = role;
      expect((await post({ ...venta, customCommissionPercentage: 30, soldOn: "2026-01-01" })).status, role).toBe(201);
    }
  });
});
