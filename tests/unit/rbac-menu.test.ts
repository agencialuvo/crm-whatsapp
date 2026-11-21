import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Menú — quién puede cambiarlo por la API: solo el propietario o un administrador (cambia lo que ve todo el equipo).
 * Un miembro del equipo recibe 403 sin tocar nada, y lo inválido (iconKey fuera del catálogo, «Ajustes» oculto) se
 * corta en la ruta con 422 antes de llegar a la base.
 */
const session = vi.hoisted(() => ({ role: "member", organizationId: "org_a", userId: "usr_1" }));
const srv = vi.hoisted(() => ({
  saveActiveMenu: vi.fn(),
  resetActiveMenu: vi.fn(),
  createMenuTemplate: vi.fn(),
  updateMenuTemplate: vi.fn(),
  deleteMenuTemplate: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ ...session }),
  getSessionOrNull: async () => ({ ...session }),
}));
vi.mock("@/server/business/menu-config", () => srv);

import { DELETE as resetMenu, PUT as putMenu } from "@/app/api/organization/menu/route";
import { POST as postTemplate } from "@/app/api/organization/menu/templates/route";
import { DELETE as deleteTemplate, PUT as putTemplate } from "@/app/api/organization/menu/templates/[id]/route";

const config = { v: 1, groups: [{ key: "gestion", items: [{ key: "servicios", label: "Programas", iconKey: "graduationCap" }] }] };
const json = (method: string, body?: unknown) =>
  new Request("http://localhost/api/organization/menu", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = { params: Promise.resolve({ id: "mnu_1" }) };

beforeEach(() => {
  for (const f of Object.values(srv)) f.mockReset();
  srv.saveActiveMenu.mockResolvedValue({ config, baseKey: null });
  srv.createMenuTemplate.mockResolvedValue({ id: "mnu_1", name: "X", config, updatedAt: "2026-01-01T00:00:00.000Z" });
  srv.updateMenuTemplate.mockResolvedValue({ id: "mnu_1", name: "X", config, updatedAt: "2026-01-01T00:00:00.000Z" });
  srv.deleteMenuTemplate.mockResolvedValue(undefined);
  srv.resetActiveMenu.mockResolvedValue(undefined);
});

describe("un miembro del equipo no toca el menú", () => {
  beforeEach(() => {
    session.role = "member";
  });
  it("PUT /menu → 403", async () => {
    expect((await putMenu(json("PUT", { config }))).status).toBe(403);
    expect(srv.saveActiveMenu).not.toHaveBeenCalled();
  });
  it("DELETE /menu → 403", async () => {
    expect((await resetMenu()).status).toBe(403);
    expect(srv.resetActiveMenu).not.toHaveBeenCalled();
  });
  it("POST /menu/templates → 403", async () => {
    expect((await postTemplate(json("POST", { name: "X", config }))).status).toBe(403);
    expect(srv.createMenuTemplate).not.toHaveBeenCalled();
  });
  it("PUT y DELETE /menu/templates/[id] → 403", async () => {
    expect((await putTemplate(json("PUT", { name: "Y" }), ctx)).status).toBe(403);
    expect((await deleteTemplate(json("DELETE"), ctx)).status).toBe(403);
    expect(srv.updateMenuTemplate).not.toHaveBeenCalled();
    expect(srv.deleteMenuTemplate).not.toHaveBeenCalled();
  });
});

describe.each(["owner", "admin"])("%s configura el menú", (role) => {
  beforeEach(() => {
    session.role = role;
  });
  it("guarda, resetea y administra plantillas de SU organización", async () => {
    expect((await putMenu(json("PUT", { config, baseKey: "marca-personal" }))).status).toBe(200);
    expect(srv.saveActiveMenu).toHaveBeenCalledWith("org_a", expect.objectContaining({ baseKey: "marca-personal" }));
    expect((await resetMenu()).status).toBe(200);
    expect(srv.resetActiveMenu).toHaveBeenCalledWith("org_a");
    expect((await postTemplate(json("POST", { name: "X", config }))).status).toBe(201);
    expect(srv.createMenuTemplate).toHaveBeenCalledWith("org_a", expect.objectContaining({ name: "X" }));
    expect((await putTemplate(json("PUT", { name: "Y" }), ctx)).status).toBe(200);
    expect(srv.updateMenuTemplate).toHaveBeenCalledWith("org_a", "mnu_1", { name: "Y" });
    expect((await deleteTemplate(json("DELETE"), ctx)).status).toBe(200);
    expect(srv.deleteMenuTemplate).toHaveBeenCalledWith("org_a", "mnu_1");
  });

  it("corta lo inválido con 422 antes de llegar a la base", async () => {
    const malos = [
      { v: 1, groups: [{ key: "gestion", items: [{ key: "medios", iconKey: "evil" }] }] },
      { v: 1, groups: [{ key: "sistema", items: [{ key: "ajustes", hidden: true }] }] },
      { v: 1, groups: [{ key: "gestion", items: [{ key: "medios", label: "x".repeat(31) }] }] },
    ];
    for (const c of malos) expect((await putMenu(json("PUT", { config: c }))).status).toBe(422);
    expect((await postTemplate(json("POST", { name: "", config }))).status).toBe(422);
    expect((await putTemplate(json("PUT", {}), ctx)).status).toBe(422);
    expect(srv.saveActiveMenu).not.toHaveBeenCalled();
    expect(srv.createMenuTemplate).not.toHaveBeenCalled();
    expect(srv.updateMenuTemplate).not.toHaveBeenCalled();
  });

  it("los errores del dominio salen con su código (nombre repetido → 409)", async () => {
    const { SalonError } = await import("@/server/business/http");
    srv.createMenuTemplate.mockRejectedValue(new SalonError("name_taken", 409, "Ya tienes una plantilla con ese nombre."));
    const res = await postTemplate(json("POST", { name: "X", config }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("name_taken");
  });
});
