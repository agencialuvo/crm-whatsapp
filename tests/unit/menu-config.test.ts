import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ICON_CATALOG, ICON_KEYS, ICON_LABELS, iconFor, isIconKey } from "@/lib/icon-catalog";
import {
  MENU_NAME_MAX,
  MENU_SYSTEM_TEMPLATES,
  applyMenuConfig,
  configFromResolved,
  findSystemTemplate,
  menuConfigSchema,
  menuTemplateNameSchema,
  parseMenuConfig,
  resolveMenu,
  suggestedTemplateKey,
  type MenuConfig,
} from "@/lib/menu-config";
import { NAV_GROUP_KEYS, NAV_ITEM_GROUP, NAV_ITEM_KEYS, PROTECTED_ITEM_KEYS } from "@/lib/nav-keys";
import { NAV_ITEM_CATALOG, SETTINGS_ITEM, appNavGroups, salonHomePath, settingsSections } from "@/lib/nav";

/**
 * Menú modular: el catálogo estable de ítems y de iconos, el esquema que valida lo que se guarda, la aplicación pura
 * (ocultar, renombrar, reordenar, mover) y sus reglas: «Ajustes» nunca se oculta, un bloque sin entradas visibles
 * desaparece, el menú no AGREGA entradas y las plantillas del sistema son de solo lectura.
 */

const base = () => appNavGroups({ salon: true, agenda: true, role: "owner" });
const hrefs = (g: { items: { href: string }[] }[]) => g.flatMap((x) => x.items.map((i) => i.href));
const labels = (g: { items: { label: string }[] }[]) => g.map((x) => x.items.map((i) => i.label));
const cfg = (groups: MenuConfig["groups"]): MenuConfig => ({ v: 1, groups });

describe("catálogo estable de ítems y bloques", () => {
  it("el catálogo cubre EXACTAMENTE las llaves de nav-keys", () => {
    expect(Object.keys(NAV_ITEM_CATALOG).sort()).toEqual([...NAV_ITEM_KEYS].sort());
    expect(Object.keys(NAV_ITEM_GROUP).sort()).toEqual([...NAV_ITEM_KEYS].sort());
    for (const g of Object.values(NAV_ITEM_GROUP)) expect(NAV_GROUP_KEYS).toContain(g);
  });

  it("cada entrada trae un iconKey del catálogo y su icono es el del catálogo", () => {
    for (const e of Object.values(NAV_ITEM_CATALOG)) expect(isIconKey(e.iconKey), e.href).toBe(true);
    for (const g of base()) {
      expect(NAV_GROUP_KEYS).toContain(g.key);
      for (const i of g.items) {
        expect(NAV_ITEM_KEYS).toContain(i.key);
        expect(i.icon).toBe(ICON_CATALOG[i.iconKey]);
        expect(NAV_ITEM_GROUP[i.key]).toBe(g.key);
      }
    }
  });

  it("las llaves de las entradas del menú son únicas", () => {
    const keys = base().flatMap((g) => g.items.map((i) => i.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("SETTINGS_ITEM conserva su identidad en el menú base", () => {
    const sistema = base().find((g) => g.bottom)!;
    expect(sistema.items).toContain(SETTINGS_ITEM);
    expect(SETTINGS_ITEM).toMatchObject({ key: "ajustes", href: "/ajustes", iconKey: "settings" });
    expect(PROTECTED_ITEM_KEYS).toContain("ajustes");
  });
});

describe("catálogo propio de iconos", () => {
  it("tiene rótulo en español para cada icono y reconoce solo sus llaves", () => {
    for (const k of ICON_KEYS) expect(ICON_LABELS[k], k).toBeTruthy();
    expect(isIconKey("userRound")).toBe(true);
    for (const bad of ["", "UserRound", "evil", "constructor", "__proto__", null, 3]) expect(isIconKey(bad), String(bad)).toBe(false);
  });
  it("incluye el icono de la marca personal y unifica el selector de sector", () => {
    expect(ICON_CATALOG.userRound).toBeDefined();
    const picker = readFileSync(join(process.cwd(), "src/components/onboarding/sector-picker.tsx"), "utf8");
    expect(picker).not.toMatch(/from "lucide-react"/);
    expect(picker).toContain("iconFor");
  });
  it("iconFor cae al de respaldo con una llave desconocida", () => {
    expect(iconFor("userRound")).toBe(ICON_CATALOG.userRound);
    expect(iconFor("nope")).toBe(ICON_CATALOG.store);
    expect(iconFor(undefined, "bell")).toBe(ICON_CATALOG.bell);
  });
});

describe("esquema de la configuración", () => {
  const ok = cfg([{ key: "trabajo", items: [{ key: "panel", label: "Inicio", iconKey: "star" }] }]);
  const bad = (c: unknown) => menuConfigSchema.safeParse(c).success;

  it("acepta una configuración válida y una vacía", () => {
    expect(bad(ok)).toBe(true);
    expect(bad(cfg([]))).toBe(true);
    expect(parseMenuConfig(ok)).toEqual(ok);
  });
  it("rechaza ítems y bloques que no existen", () => {
    expect(bad(cfg([{ key: "trabajo", items: [{ key: "inexistente" as never }] }]))).toBe(false);
    expect(bad(cfg([{ key: "otro" as never, items: [] }]))).toBe(false);
  });
  it("valida el iconKey contra el catálogo propio", () => {
    expect(bad(cfg([{ key: "trabajo", items: [{ key: "panel", iconKey: "evil" as never }] }]))).toBe(false);
    expect(bad(cfg([{ key: "trabajo", items: [{ key: "panel", iconKey: "<svg>" as never }] }]))).toBe(false);
  });
  it("limita la longitud de los nombres y no admite marcado ni vacíos", () => {
    expect(bad(cfg([{ key: "trabajo", items: [{ key: "panel", label: "x".repeat(MENU_NAME_MAX) }] }]))).toBe(true);
    expect(bad(cfg([{ key: "trabajo", items: [{ key: "panel", label: "x".repeat(MENU_NAME_MAX + 1) }] }]))).toBe(false);
    expect(bad(cfg([{ key: "trabajo", items: [{ key: "panel", label: "   " }] }]))).toBe(false);
    expect(bad(cfg([{ key: "trabajo", items: [{ key: "panel", label: "<b>hola</b>" }] }]))).toBe(false);
    expect(bad(cfg([{ key: "trabajo", title: "x".repeat(MENU_NAME_MAX + 1), items: [] }]))).toBe(false);
  });
  it("rechaza repetidos", () => {
    expect(bad(cfg([{ key: "trabajo", items: [] }, { key: "trabajo", items: [] }]))).toBe(false);
    expect(bad(cfg([{ key: "trabajo", items: [{ key: "panel" }] }, { key: "gestion", items: [{ key: "panel" }] }]))).toBe(false);
  });
  it("«Ajustes» y el bloque «Sistema» no se pueden ocultar", () => {
    expect(bad(cfg([{ key: "sistema", items: [{ key: "ajustes", hidden: true }] }]))).toBe(false);
    expect(bad(cfg([{ key: "sistema", hidden: true, items: [{ key: "ajustes" }] }]))).toBe(false);
    expect(bad(cfg([{ key: "sistema", items: [{ key: "notificaciones", hidden: true }, { key: "ajustes" }] }]))).toBe(true);
  });
  it("el bloque de abajo solo lleva lo suyo, y lo suyo no sale de él", () => {
    expect(bad(cfg([{ key: "trabajo", items: [{ key: "ajustes" }] }]))).toBe(false);
    expect(bad(cfg([{ key: "sistema", items: [{ key: "panel" }] }]))).toBe(false);
  });
  it("es estricto: no admite propiedades extra ni otra versión", () => {
    expect(bad({ v: 1, groups: [], extra: true })).toBe(false);
    expect(bad({ v: 2, groups: [] })).toBe(false);
    expect(bad(cfg([{ key: "trabajo", items: [{ key: "panel", href: "/otra" } as never] }]))).toBe(false);
  });
  it("una configuración guardada que ya no cumple el esquema se ignora (null), no rompe", () => {
    expect(parseMenuConfig({ v: 1, groups: [{ key: "trabajo", items: [{ key: "ya-no-existe" }] }] })).toBeNull();
    expect(parseMenuConfig("basura")).toBeNull();
    expect(parseMenuConfig(null)).toBeNull();
  });
  it("el nombre de una plantilla: recortado, de 1 a 40, sin marcado", () => {
    expect(menuTemplateNameSchema.safeParse("  Mi menú  ").data).toBe("Mi menú");
    expect(menuTemplateNameSchema.safeParse("").success).toBe(false);
    expect(menuTemplateNameSchema.safeParse("x".repeat(41)).success).toBe(false);
    expect(menuTemplateNameSchema.safeParse("<script>").success).toBe(false);
  });
});

describe("applyMenuConfig", () => {
  it("sin configuración devuelve el menú base tal cual (los mismos objetos)", () => {
    const b = base();
    expect(applyMenuConfig(b, null)).toBe(b);
    expect(applyMenuConfig(b, undefined)).toBe(b);
  });

  it("una configuración vacía no cambia lo que se ve (lo no mencionado queda en su bloque)", () => {
    expect(labels(applyMenuConfig(base(), cfg([])))).toEqual(labels(base()));
  });

  it("ocultar un ítem lo quita de la barra y nada más", () => {
    const out = applyMenuConfig(base(), cfg([{ key: "gestion", items: [{ key: "gastos", hidden: true }] }]));
    expect(hrefs(out)).not.toContain("/gastos");
    expect(hrefs(out)).toContain("/servicios");
    expect(hrefs(base())).toContain("/gastos"); // el menú base no se muta
  });

  it("«Ajustes» no se oculta aunque la configuración lo pida (defensa extra al esquema)", () => {
    const sucia = cfg([{ key: "sistema", hidden: true, items: [{ key: "ajustes", hidden: true }, { key: "notificaciones", hidden: true }] }]);
    const out = applyMenuConfig(base(), sucia);
    expect(hrefs(out)).toContain("/ajustes");
    expect(hrefs(out)).not.toContain("/notificaciones");
    expect(out.find((g) => g.bottom)?.items.map((i) => i.key)).toEqual(["ajustes"]);
  });

  it("ocultar un bloque oculta todas sus entradas; uno sin entradas visibles desaparece solo", () => {
    const sinTrabajo = applyMenuConfig(base(), cfg([{ key: "trabajo", hidden: true, items: [] }]));
    expect(sinTrabajo.map((g) => g.key)).toEqual(["gestion", "sistema"]);
    const todoOculto = applyMenuConfig(
      base(),
      cfg([{ key: "gestion", items: ["servicios", "equipo", "gastos", "contactos", "medios"].map((key) => ({ key: key as never, hidden: true })) }])
    );
    expect(todoOculto.map((g) => g.key)).toEqual(["trabajo", "sistema"]);
  });

  it("renombrar y cambiar el icono clona solo esa entrada; el resto conserva su identidad", () => {
    const b = base();
    const out = applyMenuConfig(b, cfg([{ key: "gestion", items: [{ key: "servicios", label: "Programas", iconKey: "graduationCap" }] }]));
    const programas = out.flatMap((g) => g.items).find((i) => i.key === "servicios")!;
    expect(programas).toMatchObject({ label: "Programas", iconKey: "graduationCap", href: "/servicios" });
    expect(programas.icon).toBe(ICON_CATALOG.graduationCap);
    const contactos = out.flatMap((g) => g.items).find((i) => i.key === "contactos")!;
    expect(contactos).toBe(b.flatMap((g) => g.items).find((i) => i.key === "contactos"));
    expect(out.find((g) => g.bottom)!.items).toContain(SETTINGS_ITEM);
  });

  it("reordena dentro de un bloque y entre bloques", () => {
    const out = applyMenuConfig(
      base(),
      cfg([
        { key: "gestion", items: [{ key: "medios" }, { key: "contactos" }] },
        { key: "trabajo", items: [{ key: "servicios" }, { key: "panel" }] },
      ])
    );
    expect(out.map((g) => g.key)).toEqual(["gestion", "trabajo", "sistema"]);
    expect(out[0]!.items.map((i) => i.key)).toEqual(["medios", "contactos", "equipo", "gastos"]);
    expect(out[1]!.items.map((i) => i.key)).toEqual(["servicios", "panel", "caja", "citas", "clientes"]);
  });

  it("renombra el título de un bloque, y el bloque de abajo siempre queda abajo", () => {
    const out = applyMenuConfig(base(), cfg([{ key: "sistema", items: [{ key: "ajustes" }] }, { key: "trabajo", title: "Mi día", items: [] }]));
    expect(out.at(-1)!.key).toBe("sistema");
    expect(out.at(-1)!.bottom).toBe(true);
    expect(out.find((g) => g.key === "trabajo")!.title).toBe("Mi día");
  });

  it("una entrada del código que la configuración no conoce aparece en su bloque de siempre", () => {
    const out = applyMenuConfig(base(), cfg([{ key: "trabajo", items: [{ key: "panel" }] }]));
    expect(out.find((g) => g.key === "trabajo")!.items.map((i) => i.key)).toEqual(["panel", "caja", "citas", "clientes"]);
  });

  it("lo que una configuración sucia pide y el menú base no trae, se ignora", () => {
    const sucia = cfg([{ key: "sistema", items: [{ key: "panel" as never }, { key: "ajustes" }] }]);
    const out = applyMenuConfig(base(), sucia);
    // «panel» no se cuela en el bloque de abajo; lo que no se mencionó (notificaciones) se agrega a continuación.
    expect(out.find((g) => g.bottom)!.items.map((i) => i.key)).toEqual(["ajustes", "notificaciones"]);
    expect(out.find((g) => g.key === "trabajo")!.items.map((i) => i.key)).toContain("panel");
  });

  it("jamás agrega entradas: un miembro del equipo no gana Caja, Panel ni Servicios por mencionarlos", () => {
    const member = appNavGroups({ salon: true, agenda: true, role: "member" });
    const out = applyMenuConfig(
      member,
      cfg([{ key: "trabajo", items: [{ key: "caja" }, { key: "panel" }, { key: "citas" }] }, { key: "gestion", items: [{ key: "servicios" }, { key: "contactos" }] }])
    );
    expect(hrefs(out)).toEqual(hrefs(member).filter((h) => hrefs(out).includes(h)));
    for (const h of ["/caja", "/panel", "/servicios", "/equipo", "/gastos"]) expect(hrefs(out)).not.toContain(h);
  });

  it("no toca el candado del plan: lo bloqueado sigue bloqueado y oculto sigue oculto", () => {
    const sinPlan = appNavGroups({ salon: true, agenda: true, role: "owner", activeModules: ["agenda"] });
    const out = applyMenuConfig(sinPlan, cfg([{ key: "trabajo", items: [{ key: "panel", hidden: true }, { key: "caja" }] }]));
    const items = out.flatMap((g) => g.items);
    expect(items.find((i) => i.key === "caja")?.locked).toBe(true);
    expect(items.find((i) => i.key === "panel")).toBeUndefined();
    expect(items.find((i) => i.key === "citas")?.locked).toBeUndefined();
  });
});

describe("resolveMenu y configFromResolved", () => {
  it("el menú sin personalizar se guarda como lo mínimo: sin nombres, iconos ni ocultos", () => {
    const c = configFromResolved(resolveMenu(base(), null));
    expect(menuConfigSchema.safeParse(c).success).toBe(true);
    expect(JSON.stringify(c)).not.toMatch(/label|iconKey|hidden|title/);
    expect(labels(applyMenuConfig(base(), c))).toEqual(labels(base()));
  });

  it("ida y vuelta: lo que sale del editor se aplica igual que la configuración de la que partió", () => {
    const original = cfg([
      { key: "gestion", title: "Mi negocio", items: [{ key: "servicios", label: "Programas", iconKey: "target" }, { key: "gastos", hidden: true }] },
    ]);
    const editor = resolveMenu(base(), original);
    const otra = configFromResolved(editor);
    expect(menuConfigSchema.safeParse(otra).success).toBe(true);
    expect(labels(applyMenuConfig(base(), otra))).toEqual(labels(applyMenuConfig(base(), original)));
  });

  it("el editor ve también lo oculto, marcado", () => {
    const editor = resolveMenu(base(), cfg([{ key: "gestion", items: [{ key: "gastos", hidden: true }] }]));
    const gastos = editor.flatMap((g) => g.items).find((r) => r.item.key === "gastos")!;
    expect(gastos.hidden).toBe(true);
    expect(editor.flatMap((g) => g.items).find((r) => r.item.key === "ajustes")!.protected).toBe(true);
  });
});

describe("plantillas base del sistema (solo lectura)", () => {
  it("todas son válidas y sus llaves y nombres son únicos", () => {
    for (const t of MENU_SYSTEM_TEMPLATES) if (t.config) expect(menuConfigSchema.safeParse(t.config).success, t.key).toBe(true);
    expect(new Set(MENU_SYSTEM_TEMPLATES.map((t) => t.key)).size).toBe(MENU_SYSTEM_TEMPLATES.length);
    expect(new Set(MENU_SYSTEM_TEMPLATES.map((t) => t.name.toLowerCase())).size).toBe(MENU_SYSTEM_TEMPLATES.length);
  });
  it("aplicarlas jamás deja el menú sin Ajustes", () => {
    for (const t of MENU_SYSTEM_TEMPLATES) {
      expect(hrefs(applyMenuConfig(base(), t.config)), t.key).toContain("/ajustes");
    }
  });
  it("«Estándar» es el menú sin personalizar", () => {
    expect(findSystemTemplate("estandar")?.config).toBeNull();
  });
  it("«Marca personal» renombra Servicios a Programas y esconde Equipo y Gastos, sin quitar Caja", () => {
    const out = applyMenuConfig(base(), findSystemTemplate("marca-personal")!.config);
    const items = out.flatMap((g) => g.items);
    expect(items.find((i) => i.key === "servicios")?.label).toBe("Programas");
    expect(hrefs(out)).toEqual(expect.arrayContaining(["/panel", "/caja", "/citas", "/servicios"]));
    expect(hrefs(out)).not.toContain("/equipo");
    expect(hrefs(out)).not.toContain("/gastos");
  });
  it("un cambio sobre una base no la muta: son datos congelados por la vista, no por el editor", () => {
    const antes = JSON.stringify(MENU_SYSTEM_TEMPLATES);
    const editor = resolveMenu(base(), findSystemTemplate("marca-personal")!.config);
    editor[0]!.items.reverse();
    configFromResolved(editor);
    expect(JSON.stringify(MENU_SYSTEM_TEMPLATES)).toBe(antes);
  });
  it("sugiere «Marca personal» solo para ese tipo de negocio", () => {
    expect(suggestedTemplateKey("personal_brand")).toBe("marca-personal");
    expect(suggestedTemplateKey("salon")).toBe("estandar");
    expect(suggestedTemplateKey(null)).toBe("estandar");
  });
});

describe("destino inicial coherente con el menú efectivo", () => {
  const sin = (...keys: string[]) => cfg([{ key: "trabajo", items: keys.map((key) => ({ key: key as never, hidden: true })) }]);

  it("sin configuración, igual que siempre", () => {
    expect(salonHomePath({ agenda: true, role: "owner" })).toBe("/panel");
    expect(salonHomePath({ agenda: true, role: "member" })).toBe("/citas");
    expect(salonHomePath({ agenda: false, role: "member" })).toBe("/contactos");
    expect(salonHomePath({ agenda: true, role: "owner", menu: null })).toBe("/panel");
  });
  it("si el Panel sigue visible, es el destino", () => {
    expect(salonHomePath({ agenda: true, role: "owner", menu: findSystemTemplate("marca-personal")!.config })).toBe("/panel");
  });
  it("si se oculta /panel, se entra a la primera entrada que sí se ve (que sigue siendo del menú)", () => {
    expect(salonHomePath({ agenda: true, role: "owner", menu: sin("panel") })).toBe("/caja");
    expect(salonHomePath({ agenda: true, role: "owner", menu: sin("panel", "caja") })).toBe("/citas");
    expect(salonHomePath({ agenda: false, role: "owner", menu: sin("panel", "caja", "clientes") })).toBe("/servicios");
  });
  it("el destino siempre es una entrada visible del menú efectivo", () => {
    for (const menu of [sin("panel"), sin("panel", "caja"), sin("panel", "caja", "citas", "clientes")]) {
      const visible = hrefs(applyMenuConfig(appNavGroups({ agenda: true, salon: true, role: "owner" }), menu));
      expect(visible).toContain(salonHomePath({ agenda: true, role: "owner", menu }));
    }
  });
  it("un miembro cuya primera entrada se oculta entra a otra visible", () => {
    const menu = cfg([{ key: "trabajo", items: [{ key: "citas", hidden: true }] }]);
    expect(salonHomePath({ agenda: true, role: "member", menu })).toBe("/contactos");
  });
  it("con todo el trabajo oculto cae a Notificaciones y, al final, a Ajustes (siempre existe)", () => {
    const todo = cfg([
      { key: "trabajo", hidden: true, items: [] },
      { key: "gestion", hidden: true, items: [] },
    ]);
    expect(salonHomePath({ agenda: true, role: "owner", menu: todo })).toBe("/notificaciones");
    const sinNotif = cfg([...todo.groups, { key: "sistema", items: [{ key: "notificaciones", hidden: true }, { key: "ajustes" }] }]);
    expect(salonHomePath({ agenda: true, role: "owner", menu: sinNotif })).toBe("/ajustes");
  });
});

describe("Ajustes → Menú", () => {
  const negocio = (o: Parameters<typeof settingsSections>[0]) => settingsSections(o).find((s) => s.title === "Negocio")!.links;

  it("por defecto no existe: los tests y las pantallas de siempre no cambian", () => {
    expect(negocio({}).map((l) => l.label)).toEqual(["Marca", "Plantillas", "Equipo"]);
    expect(settingsSections({}).flatMap((s) => s.links).some((l) => l.href === "/ajustes/menu")).toBe(false);
  });
  it("con la bandera aparece en Negocio y en ninguna otra sección", () => {
    expect(negocio({ menu: true }).map((l) => l.label)).toEqual(["Marca", "Plantillas", "Equipo", "Menú"]);
    const otras = settingsSections({ menu: true }).filter((s) => s.title !== "Negocio").flatMap((s) => s.links);
    expect(otras.some((l) => l.href === "/ajustes/menu")).toBe(false);
  });
  it("/ajustes/menu no es una entrada del menú lateral: no hay forma de ocultarla desde ahí", () => {
    expect(Object.values(NAV_ITEM_CATALOG).some((e) => e.href === "/ajustes/menu")).toBe(false);
  });
});

describe("cableado (vigilancia)", () => {
  const leer = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

  it("la configuración baja del servidor por el layout, al cascarón y a la barra (sin parpadeo)", () => {
    expect(leer("src/app/(app)/layout.tsx")).toMatch(/getMenuConfig/);
    expect(leer("src/app/(app)/layout.tsx")).toMatch(/menuConfig=\{menuConfig\}/);
    expect(leer("src/components/app-shell.tsx")).toMatch(/menuConfig=\{menuConfig\}/);
    expect(leer("src/components/app-nav.tsx")).toMatch(/applyMenuConfig\(/);
  });
  it("Ajustes → Menú solo para quien configura, y su página también lo exige", () => {
    expect(leer("src/app/(app)/ajustes/layout.tsx")).toMatch(/menu=\{!!session && canConfigure\(session\.role\)\}/);
    expect(leer("src/app/(app)/ajustes/menu/page.tsx")).toMatch(/canConfigure\(session\.role\)\) notFound\(\)/);
  });
  it("la raíz decide el destino con el menú efectivo", () => {
    expect(leer("src/app/page.tsx")).toMatch(/menu: await getMenuConfig\(/);
  });
  it("el editor usa SearchSelect (nada de <select>) y no escribe la plantilla del sistema", () => {
    const editor = leer("src/components/settings/menu-settings-client.tsx");
    expect(editor).not.toMatch(/<select[\s>]/);
    expect(editor).toContain("SearchSelect");
    expect(editor).not.toMatch(/templates\/sys/);
  });
});
