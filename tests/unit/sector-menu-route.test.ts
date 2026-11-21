import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tipo de negocio → menú. Al ELEGIR el sector (`PUT /api/organization/sector`, `choose`) el menú se adapta con la
 * plantilla del sector solo si la organización no tiene uno propio (`syncSectorMenu`); un fallo ahí nunca tumba el
 * cambio de sector; «omitir» no toca el menú; y solo quien configura puede hacerlo.
 */

const session = vi.hoisted(() => ({ role: "owner", organizationId: "org_a", userId: "usr_1" }));
vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ ...session }),
  getSessionOrNull: async () => ({ ...session }),
}));

const srv = vi.hoisted(() => ({
  chooseSector: vi.fn(),
  skipSectorSetup: vi.fn(),
  syncSectorMenu: vi.fn(),
}));
vi.mock("@/server/business/sector-setup", () => ({ chooseSector: srv.chooseSector, skipSectorSetup: srv.skipSectorSetup }));
vi.mock("@/server/business/menu-config", () => ({ syncSectorMenu: srv.syncSectorMenu }));

const put = async (body: unknown) => {
  const { PUT } = await import("@/app/api/organization/sector/route");
  return PUT(
    new Request("https://x/api/organization/sector", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
};

beforeEach(() => {
  session.role = "owner";
  for (const fn of Object.values(srv)) fn.mockReset();
  srv.chooseSector.mockResolvedValue({ ok: true, categoryKey: "personal_brand", planSlug: "demo", planChanged: false });
  srv.syncSectorMenu.mockResolvedValue("applied");
});

describe("PUT /api/organization/sector", () => {
  it("al elegir el sector adapta el menú con la plantilla de ESE sector y lo dice en la respuesta", async () => {
    const res = await put({ action: "choose", categoryKey: "personal_brand" });
    expect(res.status).toBe(200);
    expect(srv.chooseSector).toHaveBeenCalledWith("org_a", "personal_brand");
    expect(srv.syncSectorMenu).toHaveBeenCalledWith("org_a", "personal_brand");
    expect(await res.json()).toMatchObject({ ok: true, categoryKey: "personal_brand", menu: "applied" });
  });

  it.each(["applied", "cleared", "kept", "none"] as const)("devuelve el resultado «%s» del menú", async (menu) => {
    srv.syncSectorMenu.mockResolvedValue(menu);
    expect((await (await put({ action: "choose", categoryKey: "personal_brand" })).json()).menu).toBe(menu);
  });

  it("si el menú falla, el cambio de sector SÍ se guarda (es solo presentación)", async () => {
    srv.syncSectorMenu.mockRejectedValue(new Error("db caída"));
    const res = await put({ action: "choose", categoryKey: "personal_brand" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, menu: "none" });
  });

  it("un sector que no existe da 422 y NO toca el menú", async () => {
    srv.chooseSector.mockResolvedValue({ ok: false, reason: "unknown_sector" });
    const res = await put({ action: "choose", categoryKey: "no_existe" });
    expect(res.status).toBe(422);
    expect(srv.syncSectorMenu).not.toHaveBeenCalled();
  });

  it("«omitir» no toca el menú", async () => {
    const res = await put({ action: "skip" });
    expect(res.status).toBe(200);
    expect(srv.skipSectorSetup).toHaveBeenCalledWith("org_a");
    expect(srv.syncSectorMenu).not.toHaveBeenCalled();
  });

  it("un miembro del equipo recibe 403 y no cambia ni el sector ni el menú", async () => {
    session.role = "member";
    const res = await put({ action: "choose", categoryKey: "personal_brand" });
    expect(res.status).toBe(403);
    expect(srv.chooseSector).not.toHaveBeenCalled();
    expect(srv.syncSectorMenu).not.toHaveBeenCalled();
  });
});
