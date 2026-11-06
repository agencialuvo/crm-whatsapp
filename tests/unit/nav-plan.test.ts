import { describe, expect, it } from "vitest";
import { appNavGroups, type NavItem } from "@/lib/nav";

const items = (groups: ReturnType<typeof appNavGroups>): NavItem[] => groups.flatMap((g) => g.items);
const byHref = (groups: ReturnType<typeof appNavGroups>, href: string) => items(groups).find((i) => i.href === href);

describe("menú según el plan (upselling)", () => {
  const base = { agenda: true, salon: true, role: "owner" };

  it("sin datos del plan no se bloquea nada", () => {
    expect(items(appNavGroups(base)).some((i) => i.locked)).toBe(false);
  });

  it("un módulo fuera del plan se ve, pero bloqueado; los incluidos quedan libres", () => {
    const g = appNavGroups({ ...base, activeModules: ["agenda"] });
    expect(byHref(g, "/citas")?.locked).toBeUndefined();
    for (const href of ["/panel", "/caja", "/gastos", "/clientes", "/servicios", "/equipo"]) {
      expect(byHref(g, href)?.locked, href).toBe(true);
    }
  });

  it("lo que no pertenece a ningún módulo nunca se bloquea", () => {
    const g = appNavGroups({ ...base, activeModules: [] });
    for (const href of ["/contactos", "/medios", "/notificaciones", "/ajustes"]) {
      expect(byHref(g, href), href).toBeDefined();
      expect(byHref(g, href)?.locked, href).toBeUndefined();
    }
  });

  it("el plan NO crea entradas: la bandera y el rol siguen mandando", () => {
    const todos = ["agenda", "salon", "atribucion", "loyalty", "finances"];
    // SALON apagado: aunque el plan lo incluya, no aparece (la ruta respondería 404).
    expect(byHref(appNavGroups({ agenda: true, salon: false, role: "owner", activeModules: todos }), "/caja")).toBeUndefined();
    // AGENDA apagada: sin Citas.
    expect(byHref(appNavGroups({ agenda: false, salon: true, role: "owner", activeModules: todos }), "/citas")).toBeUndefined();
    // Un miembro del equipo no ve el dinero, ni bloqueado.
    expect(byHref(appNavGroups({ ...base, role: "member", activeModules: ["agenda"] }), "/caja")).toBeUndefined();
  });
});
