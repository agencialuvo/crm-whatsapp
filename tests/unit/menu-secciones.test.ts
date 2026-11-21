import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ICON_CATALOG } from "@/lib/icon-catalog";
import {
  MENU_MAX_CUSTOM_GROUPS,
  addCustomGroup,
  applyMenuConfig,
  configFromResolved,
  countCustomGroups,
  menuConfigSchema,
  moveItemToGroup,
  newCustomGroupKey,
  parseMenuConfig,
  removeCustomGroup,
  resolveMenu,
  type MenuConfig,
  type ResolvedGroup,
} from "@/lib/menu-config";
import { NAV_GROUP_KEYS, NAV_ITEM_GROUP, NAV_ITEM_KEYS, isCustomGroupKey } from "@/lib/nav-keys";
import { appNavGroups, type NavGroup, type NavItem } from "@/lib/nav";

/**
 * Menú modular — secciones PROPIAS y módulos sin duplicar. Lo que se prueba: el esquema acepta secciones propias (con
 * tope) y sigue aceptando lo guardado antes; una entrada vive en UNA sola sección (esquema, resolución y operaciones
 * del editor); eliminar una sección devuelve sus entradas a su lugar de siempre; cualquier sección —también las que
 * no tienen título base— conserva el título que se le puso; y el menú pinta el encabezado solo si existe.
 */

const base = () => appNavGroups({ salon: true, agenda: true, automations: true, role: "owner" });
const cfg = (groups: MenuConfig["groups"]): MenuConfig => ({ v: 1, groups });
const ok = (c: unknown) => menuConfigSchema.safeParse(c).success;
const msg = (c: unknown) => {
  const r = menuConfigSchema.safeParse(c);
  return r.success ? "" : (r.error.issues[0]?.message ?? "");
};
const itemKeys = (gs: readonly { items: { item?: { key: string }; key?: string }[] }[]) =>
  gs.flatMap((g) => g.items.map((i) => i.item?.key ?? i.key!));
const placement = (gs: readonly ResolvedGroup[]) => gs.map((g) => [g.key, g.items.map((r) => r.item.key)] as const);

/** Un menú base con una sección SIN título (como «Resultados» con la v2 encendida). */
const withLooseGroup = (): NavGroup[] => {
  const loose: NavItem = {
    key: "resultados",
    href: "/resultados",
    label: "Resultados",
    icon: ICON_CATALOG.chartColumn,
    iconKey: "chartColumn",
  };
  const b = base();
  const bottom = b.filter((g) => g.bottom);
  return [...b.filter((g) => !g.bottom), { key: "resultados", items: [loose] }, ...bottom];
};

const A = "sec-abc123";
const B = "sec-def456";

describe("esquema: secciones propias", () => {
  it("lo guardado ANTES (solo las 5 secciones fijas) sigue siendo válido", () => {
    expect(ok(cfg([{ key: "trabajo", title: "Mi día", items: [{ key: "panel" }] }, { key: "sistema", items: [{ key: "ajustes" }] }]))).toBe(true);
    expect(ok(cfg([]))).toBe(true);
  });

  it("acepta una sección propia con título, sin título, oculta y vacía", () => {
    expect(ok(cfg([{ key: A, title: "Mi día", items: [{ key: "panel" }, { key: "caja" }] }]))).toBe(true);
    expect(ok(cfg([{ key: A, items: [{ key: "panel" }] }]))).toBe(true);
    expect(ok(cfg([{ key: A, title: "Oculta", hidden: true, items: [{ key: "panel" }] }]))).toBe(true);
    expect(ok(cfg([{ key: A, items: [] }]))).toBe(true);
  });

  it.each(["sec-", "sec-abc", "sec-ABC123", "sec-abc_123", "SEC-abc123", "sec-abcdefghijklm", "seccion-abc123", "otro", "__proto__", ""])(
    "rechaza la llave de sección «%s»",
    (key) => {
      expect(msg(cfg([{ key, items: [] }]))).toBe("Ese bloque del menú no existe");
    }
  );

  it("el tope: hasta MENU_MAX_CUSTOM_GROUPS secciones propias, ni una más", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `sec-grupo${i}x`, items: [] as { key: (typeof NAV_ITEM_KEYS)[number] }[] }));
    expect(ok(cfg(mk(MENU_MAX_CUSTOM_GROUPS)))).toBe(true);
    expect(msg(cfg(mk(MENU_MAX_CUSTOM_GROUPS + 1)))).toMatch(/hasta \d+ secciones propias/);
    // las 5 fijas + el tope entran juntas
    const fijas = NAV_GROUP_KEYS.map((key) => ({ key, items: [] as { key: (typeof NAV_ITEM_KEYS)[number] }[] }));
    expect(ok(cfg([...fijas, ...mk(MENU_MAX_CUSTOM_GROUPS)]))).toBe(true);
    expect(ok(cfg([...fijas, ...mk(MENU_MAX_CUSTOM_GROUPS + 1)]))).toBe(false);
  });

  it("una sección repetida se rechaza", () => {
    expect(msg(cfg([{ key: A, items: [] }, { key: A, items: [] }]))).toBe("Hay un bloque repetido");
  });

  it("NUNCA el mismo módulo en dos secciones: propia con fija, o propia con propia", () => {
    expect(msg(cfg([{ key: "trabajo", items: [{ key: "panel" }] }, { key: A, items: [{ key: "panel" }] }]))).toBe("Hay un ítem repetido");
    expect(msg(cfg([{ key: A, items: [{ key: "caja" }] }, { key: B, items: [{ key: "caja" }] }]))).toBe("Hay un ítem repetido");
    expect(msg(cfg([{ key: A, items: [{ key: "caja" }, { key: "caja" }] }]))).toBe("Hay un ítem repetido");
  });

  it("«Ajustes» y «Notificaciones» no salen del bloque de abajo, y nada más entra en él", () => {
    expect(msg(cfg([{ key: A, items: [{ key: "ajustes" }] }]))).toBe("Ese ítem no se puede mover a ese bloque");
    expect(msg(cfg([{ key: A, items: [{ key: "notificaciones" }] }]))).toBe("Ese ítem no se puede mover a ese bloque");
    expect(msg(cfg([{ key: "sistema", items: [{ key: "panel" }] }]))).toBe("Ese ítem no se puede mover a ese bloque");
  });

  it("«Ajustes» sigue sin poder ocultarse y «Sistema» tampoco", () => {
    expect(ok(cfg([{ key: "sistema", items: [{ key: "ajustes", hidden: true }] }]))).toBe(false);
    expect(ok(cfg([{ key: "sistema", hidden: true, items: [] }]))).toBe(false);
  });

  it("el título de una sección propia se valida igual que cualquier nombre", () => {
    expect(ok(cfg([{ key: A, title: "<b>x</b>", items: [] }]))).toBe(false);
    expect(ok(cfg([{ key: A, title: "x".repeat(31), items: [] }]))).toBe(false);
    expect(ok(cfg([{ key: A, title: "", items: [] }]))).toBe(false);
  });

  it("una configuración con una llave desconocida se ignora entera (vale el menú estándar)", () => {
    expect(parseMenuConfig(cfg([{ key: "inventada", items: [] }]))).toBeNull();
  });
});

describe("resolveMenu / applyMenuConfig con secciones propias", () => {
  const conPropia = cfg([
    { key: "trabajo", items: [{ key: "panel" }, { key: "citas" }] },
    { key: A, title: "Mis cobros", items: [{ key: "caja" }, { key: "servicios", label: "Mis servicios" }] },
  ]);

  it("crea la sección propia desde la configuración y saca sus entradas de donde nacían", () => {
    const out = resolveMenu(base(), conPropia);
    const propia = out.find((g) => g.key === A)!;
    expect(propia).toMatchObject({ custom: true, title: "Mis cobros", defaultTitle: undefined, bottom: false });
    expect(propia.items.map((r) => r.item.key)).toEqual(["caja", "servicios"]);
    expect(propia.items[1]!.label).toBe("Mis servicios");
    // ninguna entrada repetida y ninguna perdida
    const keys = itemKeys(out);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(itemKeys(base()).sort());
  });

  it("lo que la configuración no menciona queda en su sección de siempre", () => {
    const out = resolveMenu(base(), conPropia);
    expect(out.find((g) => g.key === "trabajo")!.items.map((r) => r.item.key)).toEqual(["panel", "citas", "clientes"]);
    expect(out.find((g) => g.key === "gestion")!.items.map((r) => r.item.key)).not.toContain("servicios");
  });

  it("«Sistema» siempre queda abajo, aunque la configuración ponga una propia después", () => {
    const out = resolveMenu(base(), cfg([{ key: "sistema", items: [] }, { key: A, items: [{ key: "caja" }] }]));
    expect(out.at(-1)!.bottom).toBe(true);
    expect(out.at(-1)!.items.map((r) => r.item.key)).toEqual(["notificaciones", "ajustes"]);
  });

  it("una entrada que el menú base no trae para esta persona se ignora (no se AGREGA)", () => {
    const miembro = appNavGroups({ salon: true, agenda: true, role: "member" });
    const out = resolveMenu(miembro, cfg([{ key: A, items: [{ key: "panel" }, { key: "medios" }] }]));
    expect(out.find((g) => g.key === A)!.items.map((r) => r.item.key)).toEqual(["medios"]);
  });

  it("si la misma entrada llegara en dos secciones (config que saltó el esquema), solo cuenta la primera", () => {
    const sucia = { v: 1, groups: [{ key: A, items: [{ key: "caja" }] }, { key: B, items: [{ key: "caja" }, { key: "citas" }] }] } as MenuConfig;
    const out = resolveMenu(base(), sucia);
    expect(out.find((g) => g.key === A)!.items.map((r) => r.item.key)).toEqual(["caja"]);
    expect(out.find((g) => g.key === B)!.items.map((r) => r.item.key)).toEqual(["citas"]);
  });

  it("se pinta con su título; sin título (o sin entradas visibles) se omite el encabezado o la sección", () => {
    const out = applyMenuConfig(base(), conPropia);
    const propia = out.find((g) => g.key === A)!;
    expect(propia.title).toBe("Mis cobros");
    expect(propia.items.map((i) => i.label)).toEqual(["Caja", "Mis servicios"]);

    const sinTitulo = applyMenuConfig(base(), cfg([{ key: A, items: [{ key: "caja" }] }]));
    expect(sinTitulo.find((g) => g.key === A)).toBeDefined();
    expect("title" in sinTitulo.find((g) => g.key === A)!).toBe(false);

    const vacia = applyMenuConfig(base(), cfg([{ key: A, title: "Vacía", items: [] }]));
    expect(vacia.find((g) => g.key === A)).toBeUndefined();
  });

  it("ocultar una sección propia oculta sus entradas; «Ajustes» sigue visible en la de abajo", () => {
    const out = applyMenuConfig(base(), cfg([{ key: A, hidden: true, items: [{ key: "caja" }] }]));
    expect(out.find((g) => g.key === A)).toBeUndefined();
    expect(out.flatMap((g) => g.items).map((i) => i.key)).toContain("ajustes");
    expect(out.flatMap((g) => g.items).map((i) => i.key)).not.toContain("caja");
  });

  it("una sección que se queda sin entradas visibles desaparece sola", () => {
    const out = applyMenuConfig(base(), cfg([{ key: A, items: [{ key: "caja", hidden: true }] }]));
    expect(out.find((g) => g.key === A)).toBeUndefined();
  });

  it("las secciones propias respetan el candado del plan: la entrada sigue bloqueada, no desaparece", () => {
    const conPlan = appNavGroups({ salon: true, agenda: true, role: "owner", activeModules: ["agenda"] });
    const out = applyMenuConfig(conPlan, cfg([{ key: A, items: [{ key: "caja" }] }]));
    expect(out.find((g) => g.key === A)!.items[0]).toMatchObject({ key: "caja", locked: true });
  });
});

describe("título editable en TODA sección, también sin título base", () => {
  it("una sección sin título base (Resultados) conserva el título que se le puso", () => {
    const b = withLooseGroup();
    const out = resolveMenu(b, cfg([{ key: "resultados", title: "Medición", items: [{ key: "resultados" }] }]));
    const g = out.find((x) => x.key === "resultados")!;
    expect(g).toMatchObject({ title: "Medición", defaultTitle: undefined, custom: false });
    expect(applyMenuConfig(b, cfg([{ key: "resultados", title: "Medición", items: [{ key: "resultados" }] }])).find((x) => x.key === "resultados")!.title).toBe("Medición");
  });

  it("sin título puesto, esa sección sigue sin encabezado", () => {
    const g = resolveMenu(withLooseGroup(), null).find((x) => x.key === "resultados")!;
    expect(g.title).toBeUndefined();
    expect("title" in applyMenuConfig(withLooseGroup(), cfg([{ key: "resultados", items: [{ key: "resultados" }] }])).find((x) => x.key === "resultados")!).toBe(false);
  });

  it("el título editado viaja de ida y vuelta (resolveMenu → configFromResolved → resolveMenu)", () => {
    const b = withLooseGroup();
    const editor = resolveMenu(b, null).map((g) => (g.key === "resultados" ? { ...g, title: "  Medición  " } : g.key === "trabajo" ? { ...g, title: "Mi día" } : g));
    const c = configFromResolved(editor);
    expect(c.groups.find((g) => g.key === "resultados")!.title).toBe("Medición");
    expect(c.groups.find((g) => g.key === "trabajo")!.title).toBe("Mi día");
    expect(ok(c)).toBe(true);
    const again = resolveMenu(b, c);
    expect(again.find((g) => g.key === "resultados")!.title).toBe("Medición");
    expect(again.find((g) => g.key === "trabajo")!.title).toBe("Mi día");
  });

  it("un título vacío o igual al de siempre no se guarda", () => {
    const editor = resolveMenu(withLooseGroup(), null).map((g) => (g.key === "resultados" ? { ...g, title: "   " } : g));
    const c = configFromResolved(editor);
    expect(c.groups.find((g) => g.key === "resultados")).not.toHaveProperty("title");
    expect(c.groups.find((g) => g.key === "trabajo")).not.toHaveProperty("title");
  });

  it("el título de una sección propia se conserva y se recorta", () => {
    const next = addCustomGroup(resolveMenu(base(), null), "  Mi día  ")!;
    const c = configFromResolved(next);
    const propia = c.groups.find((g) => isCustomGroupKey(g.key))!;
    expect(propia.title).toBe("Mi día");
    expect(resolveMenu(base(), c).find((g) => g.key === propia.key)!.title).toBe("Mi día");
  });

  it("el menú no deja la palabra «Entrada suelta» en ninguna parte del código", () => {
    for (const rel of ["src/components/settings/menu-settings-client.tsx", "src/components/app-nav.tsx", "src/lib/menu-config.ts", "src/lib/nav.ts"]) {
      expect(readFileSync(join(process.cwd(), rel), "utf8"), rel).not.toMatch(/Entrada suelta/);
    }
  });

  it("app-nav pinta el encabezado solo si existe y no es vacío (también el de abajo) y usa la llave como key", () => {
    const src = readFileSync(join(process.cwd(), "src/components/app-nav.tsx"), "utf8");
    expect(src).toMatch(/group\.title\?\.trim\(\) &&/);
    expect(src).toMatch(/bottomGroup\.title\?\.trim\(\) &&/);
    expect(src).toMatch(/key=\{group\.key\}/);
    expect(src).not.toMatch(/key=\{group\.title/);
  });
});

describe("operaciones del editor (puras)", () => {
  const editor = () => resolveMenu(base(), null);

  it("moveItemToGroup mueve una entrada y NUNCA la deja en dos secciones", () => {
    const out = moveItemToGroup(editor(), "caja", "gestion");
    expect(out.find((g) => g.key === "gestion")!.items.map((r) => r.item.key)).toContain("caja");
    expect(out.find((g) => g.key === "trabajo")!.items.map((r) => r.item.key)).not.toContain("caja");
    const keys = itemKeys(out);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(itemKeys(editor()).length);
  });

  it("conserva nombre, icono y si estaba oculta", () => {
    const e = editor().map((g) => ({
      ...g,
      items: g.items.map((r) => (r.item.key === "medios" ? { ...r, label: "Archivos", iconKey: "package" as const, hidden: true } : r)),
    }));
    const moved = moveItemToGroup(e, "medios", "trabajo").find((g) => g.key === "trabajo")!.items.find((r) => r.item.key === "medios")!;
    expect(moved).toMatchObject({ label: "Archivos", iconKey: "package", hidden: true });
  });

  it("no hace nada si el destino no existe, es el mismo, o si se toca el bloque de abajo", () => {
    const e = editor();
    expect(placement(moveItemToGroup(e, "caja", "no-existe"))).toEqual(placement(e));
    expect(placement(moveItemToGroup(e, "caja", "trabajo"))).toEqual(placement(e));
    expect(placement(moveItemToGroup(e, "no-existe", "gestion"))).toEqual(placement(e));
    expect(placement(moveItemToGroup(e, "ajustes", "trabajo"))).toEqual(placement(e)); // «Ajustes» no sale de «Sistema»
    expect(placement(moveItemToGroup(e, "notificaciones", "gestion"))).toEqual(placement(e));
    expect(placement(moveItemToGroup(e, "caja", "sistema"))).toEqual(placement(e)); // nada más entra en «Sistema»
  });

  it("addCustomGroup agrega una sección vacía antes del bloque de abajo, con llave válida y única", () => {
    const next = addCustomGroup(editor(), "Mi día")!;
    expect(next.at(-1)!.bottom).toBe(true);
    const propia = next.at(-2)!;
    expect(propia).toMatchObject({ custom: true, title: "Mi día", defaultTitle: undefined, hidden: false, items: [] });
    expect(isCustomGroupKey(propia.key)).toBe(true);
    expect(new Set(next.map((g) => g.key)).size).toBe(next.length);
  });

  it("addCustomGroup respeta el tope y devuelve null al llegar a él", () => {
    let g: ResolvedGroup[] = editor();
    for (let i = 0; i < MENU_MAX_CUSTOM_GROUPS; i++) g = addCustomGroup(g)!;
    expect(countCustomGroups(g)).toBe(MENU_MAX_CUSTOM_GROUPS);
    expect(addCustomGroup(g)).toBeNull();
    expect(ok(configFromResolved(g))).toBe(true); // lo que el editor guardaría en el tope sigue siendo válido
  });

  it("newCustomGroupKey no repite una llave ya usada (reintenta)", () => {
    const seq = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    let i = 0;
    const rand = () => seq[i++ % seq.length]!;
    const first = newCustomGroupKey([], () => 0);
    expect(first).toBe("sec-000000");
    i = 0;
    const second = newCustomGroupKey([first], rand);
    expect(second).not.toBe(first);
    expect(second).toBe("sec-iiiiii");
    expect(isCustomGroupKey(second)).toBe(true);
  });

  it("removeCustomGroup devuelve las entradas a su sección de siempre, sin perder ni borrar ninguna", () => {
    let g = addCustomGroup(editor(), "Mis cobros")!;
    const key = g.find((x) => x.custom)!.key;
    g = moveItemToGroup(g, "caja", key);
    g = moveItemToGroup(g, "servicios", key);
    g = g.map((x) => (x.key === key ? { ...x, items: x.items.map((r) => (r.item.key === "servicios" ? { ...r, label: "Mis servicios", hidden: true } : r)) } : x));
    const antes = itemKeys(g).length;

    const out = removeCustomGroup(g, key);
    expect(out.some((x) => x.key === key)).toBe(false);
    expect(itemKeys(out).length).toBe(antes);
    expect(new Set(itemKeys(out)).size).toBe(antes);
    expect(out.find((x) => x.key === NAV_ITEM_GROUP.caja)!.items.map((r) => r.item.key)).toContain("caja");
    const serv = out.find((x) => x.key === NAV_ITEM_GROUP.servicios)!.items.find((r) => r.item.key === "servicios")!;
    expect(serv).toMatchObject({ label: "Mis servicios", hidden: true });
  });

  it("removeCustomGroup no elimina una sección fija ni una que no existe", () => {
    const e = editor();
    expect(placement(removeCustomGroup(e, "trabajo"))).toEqual(placement(e));
    expect(placement(removeCustomGroup(e, "sistema"))).toEqual(placement(e));
    expect(placement(removeCustomGroup(e, "sec-noexiste"))).toEqual(placement(e));
  });

  it("al eliminar una sección propia no queda rastro en lo que se guarda", () => {
    const e = editor();
    const antes = JSON.stringify(configFromResolved(e));
    const k = addCustomGroup(e, "Temporal")!;
    const sin = removeCustomGroup(k, k.find((x) => x.custom)!.key);
    expect(JSON.stringify(configFromResolved(sin))).toBe(antes);
  });

  it("al azar: cientos de movimientos, altas y bajas jamás duplican ni pierden una entrada, y lo guardado es válido y reproducible", () => {
    // PRNG con semilla: la prueba es determinista.
    let s = 20260121;
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const total = itemKeys(editor()).length;
    let g: ResolvedGroup[] = editor();
    for (let step = 0; step < 400; step++) {
      const r = rnd();
      if (r < 0.15) g = addCustomGroup(g, rnd() < 0.5 ? `S${step}` : undefined, rnd) ?? g;
      else if (r < 0.3) {
        const propias = g.filter((x) => x.custom);
        if (propias.length) g = removeCustomGroup(g, pick(propias).key);
      } else {
        const todas = g.flatMap((x) => x.items.map((i) => i.item.key));
        g = moveItemToGroup(g, pick(todas), pick(g).key);
      }
      const keys = itemKeys(g);
      expect(keys.length, `paso ${step}`).toBe(total);
      expect(new Set(keys).size, `paso ${step}`).toBe(total);
      expect(g.at(-1)!.bottom).toBe(true);
      expect(g.at(-1)!.items.map((i) => i.item.key).sort()).toEqual(["ajustes", "notificaciones"]);
      expect(countCustomGroups(g)).toBeLessThanOrEqual(MENU_MAX_CUSTOM_GROUPS);
      const c = configFromResolved(g);
      expect(menuConfigSchema.safeParse(c).success, `paso ${step}`).toBe(true);
      expect(placement(resolveMenu(base(), c)), `paso ${step}`).toEqual(placement(g));
    }
  });
});

describe("editor de Ajustes → Menú (vigilancia)", () => {
  const client = () => readFileSync(join(process.cwd(), "src/components/settings/menu-settings-client.tsx"), "utf8");
  const page = () => readFileSync(join(process.cwd(), "src/app/(app)/ajustes/menu/page.tsx"), "utf8");

  it("mover, agregar, crear y eliminar pasan SIEMPRE por las operaciones puras (que no duplican)", () => {
    const src = client();
    for (const fn of ["moveItemToGroup", "addCustomGroup", "removeCustomGroup"]) expect(src, fn).toContain(fn);
    // nada de armar a mano la lista de una sección con la entrada de otra
    expect(src).not.toMatch(/items: \[\.\.\.g\.items, moving\]/);
  });

  it("todas las secciones tienen campo de nombre editable, y las propias se pueden eliminar", () => {
    const src = client();
    expect(src).toContain('"Nombre de la sección"');
    expect(src).toMatch(/g\.custom && \(/);
    expect(src).toContain("Eliminar sección");
    expect(src).toContain("Nueva sección");
    expect(src).toContain("Agregar módulo…");
  });

  it("la plantilla del tipo de negocio se destaca sin tocar el estado (no activa «cambios sin guardar» al cargar)", () => {
    const src = client();
    expect(src).toContain("Recomendada para tu tipo de negocio");
    // el menú arranca de lo guardado, no de la sugerida: la recomendación no entra en el estado inicial
    expect(src).toMatch(/useState<ResolvedGroup\[\]>\(\(\) => resolveMenu\(base, activeConfig\)\)/);
    expect(src).not.toMatch(/useState[^;]*suggested/);
    // y se carga solo cuando la persona lo pide
    expect(src).toMatch(/onClick=\{\(\) => loadTemplate\(/);
  });

  it("la página pasa la plantilla del tipo de negocio actual al editor", () => {
    expect(page()).toContain("suggestedKey={suggestedTemplateKey(setup?.categoryKey)}");
  });

  it("al cargar sin tocar nada no hay cambios: lo que se guardaría es idéntico a lo guardado", () => {
    const guardada = cfg([{ key: A, title: "Mis cobros", items: [{ key: "caja" }] }]);
    const editor = resolveMenu(base(), guardada);
    expect(JSON.stringify(configFromResolved(editor))).toBe(JSON.stringify(configFromResolved(resolveMenu(base(), guardada))));
    expect(JSON.stringify(configFromResolved(resolveMenu(base(), null)))).toBe(JSON.stringify(configFromResolved(resolveMenu(base(), null))));
  });
});
