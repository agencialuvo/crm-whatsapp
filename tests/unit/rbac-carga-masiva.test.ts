import { describe, expect, it, vi } from "vitest";

/** Carga masiva: es configuración del negocio, así que un miembro recibe 403 y nada se procesa. */
const session = vi.hoisted(() => ({ role: "member", organizationId: "org_a", userId: "usr_1" }));
const runImport = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ ...session }),
  getSessionOrNull: async () => ({ ...session }),
}));
vi.mock("@/server/business/flag", () => ({
  salonEnabled: () => true,
  salonDisabledResponse: () => new Response(null, { status: 404 }),
}));
vi.mock("@/server/business/bulk-import", async (orig) => ({
  ...(await orig<typeof import("@/server/business/bulk-import")>()),
  runImport,
}));

import { POST } from "@/app/api/negocio/carga-masiva/route";
import { GET } from "@/app/api/negocio/carga-masiva/plantilla/route";

function upload(modulo: string) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([80, 75, 3, 4])], "x.xlsx"));
  return POST(new Request(`http://localhost/api/negocio/carga-masiva?modulo=${modulo}`, { method: "POST", body: form }));
}
const plantilla = (modulo: string) => GET(new Request(`http://localhost/api/negocio/carga-masiva/plantilla?modulo=${modulo}`));

describe("carga masiva por rol", () => {
  it("un miembro: 403 al subir y al bajar la plantilla, sin procesar nada", async () => {
    session.role = "member";
    expect((await upload("clientes")).status).toBe(403);
    expect((await plantilla("clientes")).status).toBe(403);
    expect(runImport).not.toHaveBeenCalled();
  });

  it("dueño y administrador: la plantilla baja como .xlsx y la subida se procesa", async () => {
    runImport.mockResolvedValue({ total: 1, created: 1, skipped: [], errors: [] });
    for (const role of ["owner", "admin"]) {
      session.role = role;
      const res = await plantilla("equipo");
      expect(res.status, role).toBe(200);
      expect(res.headers.get("content-type")).toContain("spreadsheetml");
      expect(res.headers.get("content-disposition")).toContain("plantilla-equipo.xlsx");
      expect((await upload("equipo")).status, role).toBe(200);
    }
    expect(runImport).toHaveBeenCalledWith("org_a", "equipo", expect.any(Buffer));
  });

  it("un módulo que no existe es 422", async () => {
    session.role = "owner";
    expect((await upload("ventas")).status).toBe(422);
    expect((await plantilla("ventas")).status).toBe(422);
  });
});
