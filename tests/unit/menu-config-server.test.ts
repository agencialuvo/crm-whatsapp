import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * Menú modular — el servidor: lo que se guarda se valida contra el catálogo (llaves, iconKey, nombres, «Ajustes»
 * visible), toda consulta va acotada a la organización, las plantillas del sistema no se pueden escribir y solo
 * quien configura el negocio toca el menú (403 al resto).
 *
 * La base es un doble en memoria que graba lo que se consulta y se escribe; el esquema es el real.
 */

type Call = { method: string; args: unknown[] };
type Chain = { [method: string]: (...args: unknown[]) => Chain };
type Q = { kind: string; table: unknown; fields: Record<string, unknown> | undefined; calls: Call[]; values?: unknown };
const h = vi.hoisted(() => ({
  queries: [] as unknown[],
  results: null as null | ((q: unknown) => unknown),
  failWith: null as null | unknown,
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  function query(kind: string, table: unknown, fields?: Record<string, unknown>) {
    const q: Q = { kind, table, fields, calls: [], values: undefined };
    h.queries.push(q);
    const proxy: Chain = new Proxy({} as Chain, {
      get(_t, prop: string) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => {
            if (h.failWith && kind !== "select") return Promise.reject(h.failWith).then(ok, err);
            const r = h.results?.(q);
            return Promise.resolve(r !== undefined ? r : []).then(ok, err);
          };
        }
        return (...args: unknown[]) => {
          q.calls.push({ method: prop, args });
          if (prop === "from") q.table = args[0];
          if (prop === "values" || prop === "set") q.values = args[0];
          return proxy;
        };
      },
    });
    return proxy;
  }
  const db = {
    select: (fields?: Record<string, unknown>) => ({ from: (t: unknown) => query("select", t, fields).from!(t) }),
    insert: (t: unknown) => query("insert", t),
    update: (t: unknown) => query("update", t),
    delete: (t: unknown) => query("delete", t),
  };
  return { ...original, getDb: () => db };
});

import { schema } from "@/lib/db";
import { MENU_MAX_TEMPLATES, MENU_SYSTEM_TEMPLATES, type MenuConfig } from "@/lib/menu-config";
import {
  createMenuTemplate,
  deleteMenuTemplate,
  getActiveMenu,
  getMenuConfig,
  listMenuTemplates,
  resetActiveMenu,
  saveActiveMenu,
  syncSectorMenu,
  updateMenuTemplate,
} from "@/server/business/menu-config";

const t = schema.menuConfig;
const qs = () => h.queries as Q[];
const ofKind = (kind: string) => qs().filter((q) => q.kind === kind && q.table === t);
const whereOf = (q: Q) => new PgDialect().sqlToQuery(q.calls.find((c) => c.method === "where")!.args[0] as never);

const valido: MenuConfig = {
  v: 1,
  groups: [
    { key: "gestion", items: [{ key: "servicios", label: "Programas", iconKey: "graduationCap" }, { key: "gastos", hidden: true }] },
    { key: "sistema", items: [{ key: "notificaciones" }, { key: "ajustes" }] },
  ],
};

beforeEach(() => {
  h.queries = [];
  h.results = null;
  h.failWith = null;
});

describe("configuración activa", () => {
  it("guarda una sola por organización: upsert sobre el índice parcial, con la configuración validada", async () => {
    const r = await saveActiveMenu("org_a", { config: valido, baseKey: "marca-personal" });
    const [ins] = ofKind("insert");
    expect(ins!.values).toMatchObject({ organizationId: "org_a", kind: "active", name: null, baseKey: "marca-personal", config: valido });
    const upsert = ins!.calls.find((c) => c.method === "onConflictDoUpdate")!.args[0] as { target: unknown[]; targetWhere: unknown; set: Record<string, unknown> };
    expect(upsert.target).toEqual([t.organizationId]);
    expect(upsert.targetWhere).toBeDefined();
    expect(upsert.set).toMatchObject({ config: valido, baseKey: "marca-personal" });
    expect(r).toEqual({ config: valido, baseKey: "marca-personal" });
  });

  it("elegir una plantilla del sistema solo anota de cuál partió: no escribe nada «de sistema»", async () => {
    const antes = JSON.stringify(MENU_SYSTEM_TEMPLATES);
    await saveActiveMenu("org_a", { config: valido, baseKey: "marca-personal" });
    expect(ofKind("insert").every((q) => (q.values as { kind: string }).kind === "active")).toBe(true);
    expect(JSON.stringify(MENU_SYSTEM_TEMPLATES)).toBe(antes);
  });

  it.each([
    ["un iconKey fuera del catálogo", { v: 1, groups: [{ key: "gestion", items: [{ key: "medios", iconKey: "evil" }] }] }],
    ["un ítem que no existe", { v: 1, groups: [{ key: "gestion", items: [{ key: "inventado" }] }] }],
    ["un bloque que no existe", { v: 1, groups: [{ key: "otro", items: [] }] }],
    ["un nombre de más de 30 caracteres", { v: 1, groups: [{ key: "gestion", items: [{ key: "medios", label: "x".repeat(31) }] }] }],
    ["un nombre con marcado", { v: 1, groups: [{ key: "gestion", items: [{ key: "medios", label: "<img src=x>" }] }] }],
    ["«Ajustes» oculto", { v: 1, groups: [{ key: "sistema", items: [{ key: "ajustes", hidden: true }] }] }],
    ["el bloque «Sistema» oculto", { v: 1, groups: [{ key: "sistema", hidden: true, items: [{ key: "ajustes" }] }] }],
    ["un ítem repetido", { v: 1, groups: [{ key: "gestion", items: [{ key: "medios" }, { key: "medios" }] }] }],
    ["otra versión", { v: 9, groups: [] }],
    ["basura", "no soy un objeto"],
  ])("rechaza %s con 422 y no escribe nada", async (_nombre, config) => {
    await expect(saveActiveMenu("org_a", { config })).rejects.toMatchObject({ code: "invalid_menu", status: 422 });
    expect(ofKind("insert")).toHaveLength(0);
  });

  it("rechaza una plantilla de origen mal formada", async () => {
    await expect(saveActiveMenu("org_a", { config: valido, baseKey: "../etc/passwd" })).rejects.toMatchObject({ code: "invalid_menu" });
    expect(ofKind("insert")).toHaveLength(0);
  });

  it("lee la activa acotada a la organización y al tipo «active»", async () => {
    h.results = () => [{ config: valido, baseKey: "estandar" }];
    expect(await getActiveMenu("org_a")).toEqual({ config: valido, baseKey: "estandar" });
    const q = whereOf(ofKind("select")[0]!);
    expect(q.params).toEqual(expect.arrayContaining(["org_a", "active"]));
    expect(q.sql).toContain("organization_id");
  });

  it("sin fila, o con una guardada que ya no cumple el esquema, vale el menú estándar (null)", async () => {
    h.results = () => [];
    expect(await getActiveMenu("org_a")).toBeNull();
    h.results = () => [{ config: { v: 1, groups: [{ key: "gestion", items: [{ key: "ya-no-existe" }] }] }, baseKey: null }];
    expect(await getActiveMenu("org_a")).toBeNull();
  });

  it("para el menú, un fallo de lectura nunca lanza: deja el estándar", async () => {
    h.results = () => {
      throw new Error("BD caída");
    };
    await expect(getMenuConfig("org_a")).resolves.toBeNull();
  });

  it("volver al estándar borra solo la activa de ESA organización (las plantillas no)", async () => {
    await resetActiveMenu("org_a");
    const [del] = ofKind("delete");
    const w = whereOf(del!);
    expect(w.params).toEqual(expect.arrayContaining(["org_a", "active"]));
    expect(w.params).not.toContain("template");
  });
});

describe("plantillas guardadas de la organización", () => {
  const fila = { id: "mnu_1", name: "Mi menú", config: valido, updatedAt: new Date("2026-03-10T15:00:00Z") };

  it("lista solo las de la organización y descarta las que ya no son válidas", async () => {
    h.results = () => [fila, { ...fila, id: "mnu_2", name: "Rota", config: { v: 1, groups: [{ key: "gestion", items: [{ key: "ya-no" }] }] } }];
    const lista = await listMenuTemplates("org_a");
    expect(lista.map((x) => x.name)).toEqual(["Mi menú"]);
    expect(whereOf(ofKind("select")[0]!).params).toEqual(expect.arrayContaining(["org_a", "template"]));
  });

  it("crea una plantilla NUEVA (nunca una de sistema) con su nombre recortado", async () => {
    h.results = (raw) => {
      const q = raw as Q;
      if (q.kind === "select") return [{ n: 0 }];
      return [{ ...fila, name: (q.values as { name: string }).name }];
    };
    const r = await createMenuTemplate("org_a", { name: "  Mi menú  ", config: valido });
    expect(ofKind("insert")[0]!.values).toMatchObject({ organizationId: "org_a", kind: "template", name: "Mi menú", config: valido });
    expect(r).toMatchObject({ id: "mnu_1", name: "Mi menú" });
  });

  it.each(["", "x".repeat(41), "<b>x</b>"])("rechaza el nombre %j", async (name) => {
    await expect(createMenuTemplate("org_a", { name, config: valido })).rejects.toMatchObject({ code: "invalid_menu", status: 422 });
    expect(ofKind("insert")).toHaveLength(0);
  });

  it("no deja llamar una plantilla como una del sistema (sin importar mayúsculas)", async () => {
    await expect(createMenuTemplate("org_a", { name: "ESTÁNDAR", config: valido })).rejects.toMatchObject({ code: "name_taken", status: 409 });
    await expect(createMenuTemplate("org_a", { name: "marca personal", config: valido })).rejects.toMatchObject({ code: "name_taken" });
    expect(ofKind("insert")).toHaveLength(0);
  });

  it("valida la configuración también al guardar una plantilla", async () => {
    await expect(createMenuTemplate("org_a", { name: "X", config: { v: 1, groups: [{ key: "gestion", items: [{ key: "medios", iconKey: "evil" }] }] } })).rejects.toMatchObject({ code: "invalid_menu" });
    expect(ofKind("insert")).toHaveLength(0);
  });

  it("tope de plantillas por organización", async () => {
    h.results = (raw) => ((raw as Q).kind === "select" ? [{ n: MENU_MAX_TEMPLATES }] : []);
    await expect(createMenuTemplate("org_a", { name: "Otra", config: valido })).rejects.toMatchObject({ code: "too_many_templates", status: 409 });
    expect(ofKind("insert")).toHaveLength(0);
  });

  it("un nombre repetido (índice único) sale como 409 name_taken", async () => {
    h.results = (raw) => ((raw as Q).kind === "select" ? [{ n: 1 }] : []);
    h.failWith = { code: "23505" };
    await expect(createMenuTemplate("org_a", { name: "Mi menú", config: valido })).rejects.toMatchObject({ code: "name_taken", status: 409 });
  });

  it("actualizar acota por organización, id y tipo «template»; sin fila es 404", async () => {
    h.results = () => [];
    await expect(updateMenuTemplate("org_a", "mnu_x", { name: "Nuevo" })).rejects.toMatchObject({ code: "not_found", status: 404 });
    const w = whereOf(ofKind("update")[0]!);
    expect(w.params).toEqual(expect.arrayContaining(["org_a", "mnu_x", "template"]));
  });

  it("actualizar valida lo que cambia", async () => {
    await expect(updateMenuTemplate("org_a", "mnu_1", { config: { v: 1, groups: [{ key: "sistema", items: [{ key: "ajustes", hidden: true }] }] } })).rejects.toMatchObject({ code: "invalid_menu" });
    expect(ofKind("update")).toHaveLength(0);
  });

  it("actualiza y devuelve la plantilla", async () => {
    h.results = () => [{ ...fila, name: "Renombrada" }];
    const r = await updateMenuTemplate("org_a", "mnu_1", { name: "Renombrada" });
    expect(r.name).toBe("Renombrada");
    expect(ofKind("update")[0]!.values).toMatchObject({ name: "Renombrada" });
  });

  it("eliminar acota igual y avisa si no existe", async () => {
    h.results = () => [];
    await expect(deleteMenuTemplate("org_a", "mnu_x")).rejects.toMatchObject({ code: "not_found" });
    expect(whereOf(ofKind("delete")[0]!).params).toEqual(expect.arrayContaining(["org_a", "mnu_x", "template"]));
    h.results = () => [{ id: "mnu_x" }];
    await expect(deleteMenuTemplate("org_a", "mnu_x")).resolves.toBeUndefined();
  });
});

describe("el menú sigue al tipo de negocio (syncSectorMenu)", () => {
  const tpl = (key: string) => MENU_SYSTEM_TEMPLATES.find((x) => x.key === key)!.config as MenuConfig;
  const activa = (row: { config: unknown; baseKey: string | null } | null) => {
    h.results = (q) => ((q as Q).kind === "select" ? (row ? [row] : []) : []);
  };
  const writes = () => qs().filter((q) => q.table === t && q.kind !== "select");

  it("sin menú: aplica la plantilla del sector SIN pisar a otra pestaña (onConflictDoNothing) y acotada a la organización", async () => {
    activa(null);
    expect(await syncSectorMenu("org_a", "personal_brand")).toBe("applied");
    const [ins] = ofKind("insert");
    expect(ins!.values).toMatchObject({ organizationId: "org_a", kind: "active", name: null, baseKey: "marca-personal", config: tpl("marca-personal") });
    expect(ins!.calls.some((c) => c.method === "onConflictDoNothing")).toBe(true);
    expect(ins!.calls.some((c) => c.method === "onConflictDoUpdate")).toBe(false);
    expect(whereOf(ofKind("select")[0]!).params).toContain("org_a");
  });

  it("sin menú y con un tipo de negocio de menú estándar: no escribe nada", async () => {
    activa(null);
    expect(await syncSectorMenu("org_a", "health")).toBe("none");
    expect(writes()).toHaveLength(0);
  });

  it("con un menú PROPIO (sin plantilla de origen) no toca nada", async () => {
    activa({ config: valido, baseKey: null });
    expect(await syncSectorMenu("org_a", "personal_brand")).toBe("kept");
    expect(writes()).toHaveLength(0);
  });

  it("con una plantilla del sistema EDITADA después no toca nada", async () => {
    const editada = JSON.parse(JSON.stringify(tpl("marca-personal"))) as MenuConfig;
    editada.groups[0]!.items.reverse();
    activa({ config: editada, baseKey: "marca-personal" });
    expect(await syncSectorMenu("org_a", "salon")).toBe("kept");
    expect(writes()).toHaveLength(0);
  });

  it("con una plantilla PROPIA de la organización aplicada (baseKey = su id) no toca nada", async () => {
    activa({ config: tpl("marca-personal"), baseKey: "mnu_abc123" });
    expect(await syncSectorMenu("org_a", "salon")).toBe("kept");
    expect(writes()).toHaveLength(0);
  });

  it("una plantilla del sistema que nadie tocó se cambia por la del sector nuevo, solo si la fila sigue siendo la leída", async () => {
    activa({ config: tpl("marca-personal"), baseKey: "marca-personal" });
    expect(await syncSectorMenu("org_a", "salon")).toBe("applied");
    const [up] = ofKind("update");
    expect(up!.values).toMatchObject({ config: tpl("salon-barberia"), baseKey: "salon-barberia" });
    const w = whereOf(up!);
    expect(w.params).toEqual(expect.arrayContaining(["org_a", "active", "marca-personal"]));
    expect(ofKind("delete")).toHaveLength(0);
  });

  it("una plantilla del sistema intacta vuelve al estándar (se borra la activa) si el sector nuevo no tiene plantilla propia", async () => {
    activa({ config: tpl("marca-personal"), baseKey: "marca-personal" });
    expect(await syncSectorMenu("org_a", "services")).toBe("cleared");
    const [del] = ofKind("delete");
    expect(whereOf(del!).params).toEqual(expect.arrayContaining(["org_a", "active", "marca-personal"]));
    expect(ofKind("update")).toHaveLength(0);
  });

  it("elegir el mismo sector otra vez no escribe nada", async () => {
    activa({ config: tpl("marca-personal"), baseKey: "marca-personal" });
    expect(await syncSectorMenu("org_a", "personal_brand")).toBe("none");
    expect(writes()).toHaveLength(0);
  });

  it("lo guardado que ya no cumple el esquema cuenta como propio (se conserva)", async () => {
    activa({ config: { v: 1, groups: [{ key: "inventada", items: [] }] }, baseKey: "marca-personal" });
    expect(await syncSectorMenu("org_a", "salon")).toBe("kept");
    expect(writes()).toHaveLength(0);
  });
});
