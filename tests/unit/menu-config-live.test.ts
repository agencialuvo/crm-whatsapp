import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Menú personalizable contra PostgreSQL REAL (`pnpm test:db`): el upsert de la configuración activa sobre el índice
 * parcial (`onConflictDoUpdate` + `targetWhere`), alta/lectura/edición/baja de plantillas, el tope, la unicidad de
 * nombre sin distinguir mayúsculas y el aislamiento entre organizaciones. Crea sus propias organizaciones y las borra
 * (la cascada limpia `menu_config`).
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("menú personalizable contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let svc: typeof import("@/server/business/menu-config");
  let lib: typeof import("@/lib/menu-config");

  const tag = Date.now().toString(36);
  const orgA = `org_ml${tag}a`;
  const orgB = `org_ml${tag}b`;

  beforeAll(async () => {
    ({ eq, inArray } = await import("drizzle-orm"));
    const m = await import("@/lib/db");
    db = m.getDb();
    schema = m.schema;
    svc = await import("@/server/business/menu-config");
    lib = await import("@/lib/menu-config");
    await db.insert(schema.organization).values([
      { id: orgA, name: `Menu live A ${tag}` },
      { id: orgB, name: `Menu live B ${tag}` },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.organization).where(inArray(schema.organization.id, [orgA, orgB]));
  });

  const base = () => lib.MENU_SYSTEM_TEMPLATES.find((t) => t.key === "marca-personal")!.config;

  it("sin configuración: el menú es el estándar (null)", async () => {
    expect(await svc.getActiveMenu(orgA)).toBeNull();
    expect(await svc.getMenuConfig(orgA)).toBeNull();
  });

  it("el upsert de la activa crea la fila y la segunda vez la REEMPLAZA (una sola por organización)", async () => {
    await svc.saveActiveMenu(orgA, { config: base(), baseKey: "marca-personal" });
    // Otra configuración válida (la base «estandar» no sirve: su config es null = sin personalizar).
    const otra = { v: 1, groups: [{ key: "trabajo", title: "Mi trabajo", items: [{ key: "panel", label: "Inicio" }] }] };
    await svc.saveActiveMenu(orgA, { config: otra, baseKey: null });
    const rows = await db.select().from(schema.menuConfig).where(eq(schema.menuConfig.organizationId, orgA));
    expect(rows.filter((r) => r.kind === "active")).toHaveLength(1);
    expect(rows.find((r) => r.kind === "active")?.baseKey).toBeNull();
    expect((rows.find((r) => r.kind === "active")?.config as { groups: { title: string }[] }).groups[0]?.title).toBe("Mi trabajo");
  });

  it("la activa guardada se lee igual y no se mezcla con otra organización", async () => {
    await svc.saveActiveMenu(orgA, { config: base(), baseKey: "marca-personal" });
    const a = await svc.getActiveMenu(orgA);
    expect(a?.baseKey).toBe("marca-personal");
    expect(a?.config).toEqual(base());
    expect(await svc.getActiveMenu(orgB)).toBeNull();
  });

  it("rechaza configuraciones inválidas sin escribir nada", async () => {
    await expect(svc.saveActiveMenu(orgB, { config: { v: 1, groups: [{ key: "trabajo", items: [{ key: "inventada" }] }] } })).rejects.toMatchObject({ status: 422 });
    expect(await svc.getActiveMenu(orgB)).toBeNull();
  });

  it("plantillas: crear, listar, editar y eliminar", async () => {
    const t = await svc.createMenuTemplate(orgA, { name: "Mi plantilla", config: base() });
    expect(t.id.startsWith("mnu_")).toBe(true);
    expect((await svc.listMenuTemplates(orgA)).map((x) => x.name)).toEqual(["Mi plantilla"]);
    expect(await svc.listMenuTemplates(orgB)).toEqual([]);

    const up = await svc.updateMenuTemplate(orgA, t.id, { name: "Renombrada" });
    expect(up.name).toBe("Renombrada");
    // otra organización no puede tocarla
    await expect(svc.updateMenuTemplate(orgB, t.id, { name: "Robada" })).rejects.toMatchObject({ status: 404 });
    await expect(svc.deleteMenuTemplate(orgB, t.id)).rejects.toMatchObject({ status: 404 });

    await svc.deleteMenuTemplate(orgA, t.id);
    expect(await svc.listMenuTemplates(orgA)).toEqual([]);
    await expect(svc.deleteMenuTemplate(orgA, t.id)).rejects.toMatchObject({ status: 404 });
  });

  it("el nombre es único por organización sin distinguir mayúsculas y no puede ser el de una base del sistema", async () => {
    await svc.createMenuTemplate(orgA, { name: "Caja y citas", config: base() });
    await expect(svc.createMenuTemplate(orgA, { name: "CAJA Y CITAS", config: base() })).rejects.toMatchObject({ code: "name_taken" });
    // la misma en OTRA organización sí se puede
    await svc.createMenuTemplate(orgB, { name: "Caja y citas", config: base() });
    await expect(svc.createMenuTemplate(orgA, { name: "Marca personal", config: base() })).rejects.toMatchObject({ code: "name_taken" });
  });

  it("volver al estándar borra la activa pero conserva las plantillas", async () => {
    await svc.saveActiveMenu(orgA, { config: base(), baseKey: null });
    await svc.resetActiveMenu(orgA);
    expect(await svc.getActiveMenu(orgA)).toBeNull();
    expect((await svc.listMenuTemplates(orgA)).length).toBeGreaterThan(0);
  });

  it("una configuración con SECCIONES PROPIAS se guarda y se lee igual", async () => {
    const conPropias = {
      v: 1,
      groups: [
        { key: "trabajo", items: [{ key: "panel" }] },
        { key: "sec-abc123", title: "Mis cobros", items: [{ key: "caja" }, { key: "servicios", label: "Servicios" }] },
        { key: "sec-def456", items: [] },
      ],
    };
    await svc.saveActiveMenu(orgA, { config: conPropias, baseKey: null });
    expect((await svc.getActiveMenu(orgA))?.config).toEqual(conPropias);
    // un módulo repetido en dos secciones no entra
    await expect(
      svc.saveActiveMenu(orgA, { config: { v: 1, groups: [{ key: "trabajo", items: [{ key: "caja" }] }, { key: "sec-abc123", items: [{ key: "caja" }] }] } })
    ).rejects.toMatchObject({ status: 422 });
    expect((await svc.getActiveMenu(orgA))?.config).toEqual(conPropias);
    await svc.resetActiveMenu(orgA);
  });

  it("syncSectorMenu: aplica la plantilla del sector, la cambia si nadie la tocó y NUNCA pisa un menú propio", async () => {
    await svc.resetActiveMenu(orgA);
    // sin menú → la del sector
    expect(await svc.syncSectorMenu(orgA, "personal_brand")).toBe("applied");
    expect((await svc.getActiveMenu(orgA))?.baseKey).toBe("marca-personal");
    // mismo sector otra vez → nada
    expect(await svc.syncSectorMenu(orgA, "personal_brand")).toBe("none");
    // otro sector con plantilla → se cambia (nadie la tocó)
    expect(await svc.syncSectorMenu(orgA, "salon")).toBe("applied");
    expect((await svc.getActiveMenu(orgA))?.baseKey).toBe("salon-barberia");
    // sector sin plantilla propia → vuelve al estándar
    expect(await svc.syncSectorMenu(orgA, "health")).toBe("cleared");
    expect(await svc.getActiveMenu(orgA)).toBeNull();
    // un menú PROPIO nunca se toca
    const propio = { v: 1, groups: [{ key: "sec-abc123", title: "Mío", items: [{ key: "caja" }] }] };
    await svc.saveActiveMenu(orgA, { config: propio, baseKey: null });
    for (const sector of ["personal_brand", "salon", "health"]) expect(await svc.syncSectorMenu(orgA, sector)).toBe("kept");
    expect((await svc.getActiveMenu(orgA))?.config).toEqual(propio);
    // una plantilla del sistema EDITADA tampoco
    await svc.saveActiveMenu(orgA, { config: { ...base()!, groups: [...base()!.groups].reverse() }, baseKey: "marca-personal" });
    expect(await svc.syncSectorMenu(orgA, "salon")).toBe("kept");
    expect((await svc.getActiveMenu(orgA))?.baseKey).toBe("marca-personal");
    await svc.resetActiveMenu(orgA);
    const filas = await db.select().from(schema.menuConfig).where(eq(schema.menuConfig.organizationId, orgA));
    expect(filas.filter((r) => r.kind === "active")).toHaveLength(0);
  });

  it("borrar la organización limpia sus filas (cascada)", async () => {
    await db.delete(schema.organization).where(eq(schema.organization.id, orgB));
    const left = await db.select().from(schema.menuConfig).where(eq(schema.menuConfig.organizationId, orgB));
    expect(left).toHaveLength(0);
  });
});
