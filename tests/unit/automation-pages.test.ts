import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appNavGroups } from "@/lib/nav";

/**
 * Automatizaciones (pantallas) — la bandera `AUTOMATIONS` decide si existen (404) y el rol quién las ve:
 * la guarda de las páginas y la entrada del menú dicen lo mismo que la API.
 */

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
const getSessionOrNull = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getSessionOrNull: () => getSessionOrNull() }));

const session = (role: string) => ({ userId: "u", organizationId: "org_1", role });

describe("requireAutomationsPage", () => {
  const original = process.env.AUTOMATIONS;
  beforeEach(() => getSessionOrNull.mockReset());
  afterEach(() => {
    if (original === undefined) delete process.env.AUTOMATIONS;
    else process.env.AUTOMATIONS = original;
  });

  async function guard() {
    return (await import("@/server/automation/page-guard")).requireAutomationsPage();
  }

  it("apagado: la pantalla no existe (404), con o sin sesión, sin ni mirar quién es", async () => {
    delete process.env.AUTOMATIONS;
    getSessionOrNull.mockResolvedValue(session("owner"));
    await expect(guard()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getSessionOrNull).not.toHaveBeenCalled();
  });
  it("encendido y sin sesión: al inicio de sesión", async () => {
    process.env.AUTOMATIONS = "on";
    getSessionOrNull.mockResolvedValue(null);
    await expect(guard()).rejects.toThrow("NEXT_REDIRECT:/iniciar-sesion");
  });
  it("un miembro del equipo recibe 404: no se le enseña que existe", async () => {
    process.env.AUTOMATIONS = "on";
    getSessionOrNull.mockResolvedValue(session("member"));
    await expect(guard()).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("el dueño y el administrador pasan", async () => {
    process.env.AUTOMATIONS = "on";
    for (const role of ["owner", "admin"]) {
      getSessionOrNull.mockResolvedValue(session(role));
      await expect(guard()).resolves.toMatchObject({ role });
    }
  });
});

describe("entrada «Automatizaciones» del menú", () => {
  const items = (opts: Parameters<typeof appNavGroups>[0]) =>
    appNavGroups(opts).flatMap((g) => g.items.map((i) => ({ group: g.title, ...i })));
  const entry = (opts: Parameters<typeof appNavGroups>[0]) => items(opts).find((i) => i.href === "/automatizaciones");

  it("con la bandera y el rol de configuración aparece en «Gestión y equipo»", () => {
    expect(entry({ automations: true, role: "owner" })).toMatchObject({
      label: "Automatizaciones",
      group: "Gestión y equipo",
    });
    expect(entry({ automations: true, role: "admin" })).toBeDefined();
  });
  it("sin la bandera no existe, ni para el dueño", () => {
    expect(entry({ role: "owner" })).toBeUndefined();
    expect(entry({ automations: false, role: "owner" })).toBeUndefined();
  });
  it("un miembro del equipo no la ve aunque esté encendida", () => {
    expect(entry({ automations: true, role: "member" })).toBeUndefined();
  });
  it("no depende de SALON ni de AGENDA", () => {
    expect(entry({ automations: true, role: "owner", salon: false, agenda: false })).toBeDefined();
    expect(entry({ automations: true, role: "owner", salon: true, agenda: true })).toBeDefined();
  });
  it("encenderla no mueve ni quita el resto del menú", () => {
    const base = items({ role: "owner", salon: true }).map((i) => i.href);
    const withIt = items({ role: "owner", salon: true, automations: true }).map((i) => i.href);
    expect(withIt.filter((h) => h !== "/automatizaciones")).toEqual(base);
  });
});
