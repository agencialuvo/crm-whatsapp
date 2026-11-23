import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Monedas, 5.3, contra PostgreSQL REAL: el catálogo de paquetes (crear, listar, editar, activar/desactivar), el nombre
 * único aun con altas simultáneas, el tope de paquetes, la auditoría, y que lo que ve un cliente sean solo los activos.
 * También que editar o desactivar un paquete no altere una compra ya creada.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("monedas 5.3 (base real)", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let like: (typeof import("drizzle-orm"))["like"];
  let or: (typeof import("drizzle-orm"))["or"];
  let c: typeof import("@/server/credits");
  let sa: typeof import("@/server/super-admin/credits");
  let sum: typeof import("@/server/saas/credits-summary");
  let lib: typeof import("@/lib/credits");

  const tag = Date.now().toString(36);
  const adminId = `usr_k${tag}`;
  const actor = () => ({ userId: adminId, email: `k.${tag}@example.com`, ip: "10.0.0.9" });
  const orgId = `org_k${tag}`;
  const nm = (n: string) => `Prueba ${tag} ${n}`;
  const base = (n: string, over: Partial<Parameters<typeof sa.packCreate>[1]> = {}) => ({ name: nm(n), coins: 500, priceCents: 4990, currency: "PEN" as const, sortOrder: 0, active: true, ...over });
  const mine = async () => (await db.select().from(schema.creditPack)).filter((p) => p.name.startsWith(`Prueba ${tag}`));

  beforeAll(async () => {
    ({ eq, like, or } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    c = await import("@/server/credits");
    sa = await import("@/server/super-admin/credits");
    sum = await import("@/server/saas/credits-summary");
    lib = await import("@/lib/credits");
    await db.insert(schema.user).values({ id: adminId, name: "Admin K", email: `k.${tag}@example.com` });
    await db.insert(schema.organization).values({ id: orgId, name: `Org ${orgId}`, slug: orgId.toLowerCase() });
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.creditTopup).where(eq(schema.creditTopup.organizationId, orgId));
    await db.delete(schema.creditPack).where(like(schema.creditPack.name, `Prueba ${tag}%`));
    await db.delete(schema.superAdminAudit).where(or(eq(schema.superAdminAudit.actorUserId, adminId)));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await db.delete(schema.user).where(eq(schema.user.id, adminId));
  });

  it("crea un paquete: monedas → unidades, precio en centavos y valores por defecto", async () => {
    vi.stubEnv("CREDITS", ""); // el catálogo no depende de la bandera
    const r = await sa.packCreate(actor(), base("A", { coins: 12.5, priceCents: 1990 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack).toMatchObject({ name: nm("A"), units: 1_250, priceCents: 1990, currency: "PEN", active: true, sortOrder: 0 });
    expect(r.pack.id).toMatch(/^crk_/);
    expect(r.pack.pricePerCoinCents).toBeCloseTo(159.2, 1); // 1990 / 12,5 monedas
  });

  it("el nombre es único sin distinguir mayúsculas ni espacios repetidos", async () => {
    const r = await sa.packCreate(actor(), base("A", { name: `  ${nm("A").toUpperCase()}  ` }));
    expect(r).toMatchObject({ ok: false, status: 409, code: "name_taken" });
    expect((await mine()).filter((p) => p.name.toLowerCase() === nm("A").toLowerCase())).toHaveLength(1);
  });

  it("altas simultáneas con el mismo nombre: entra UNA", async () => {
    const res = await Promise.all(Array.from({ length: 6 }, () => sa.packCreate(actor(), base("Carrera"))));
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(res.filter((r) => !r.ok && r.code === "name_taken")).toHaveLength(5);
    expect((await mine()).filter((p) => p.name === nm("Carrera"))).toHaveLength(1);
  });

  it("la base misma rechaza monedas o precio fuera de rango (defensa en profundidad)", async () => {
    const a = actor();
    await expect(c.createPack({ name: nm("Mal1"), units: 0, priceCents: 100 }, a)).rejects.toThrow();
    await expect(c.createPack({ name: nm("Mal2"), units: 100, priceCents: 0 }, a)).rejects.toThrow();
    await expect(c.createPack({ name: "x", units: 100, priceCents: 100 }, a)).rejects.toThrow();
    await expect(c.createPack({ name: nm("Mal3"), units: 1.5, priceCents: 100 }, a)).rejects.toThrow();
    await expect(c.createPack({ name: nm("Mal4"), units: 100, priceCents: 100, currency: "EUR" as never }, a)).rejects.toThrow();
    expect((await mine()).some((p) => p.name.startsWith(nm("Mal")))).toBe(false);
  });

  it("edita nombre, monedas, precio y orden; cambiar al nombre de otro paquete es 409", async () => {
    const b = await sa.packCreate(actor(), base("B", { sortOrder: 5 }));
    if (!b.ok) throw new Error("x");
    const r = await sa.packUpdate(actor(), b.pack.id, { name: nm("B2"), coins: 1000, priceCents: 8990, sortOrder: 2 });
    expect(r).toMatchObject({ ok: true, changed: true, pack: { name: nm("B2"), units: 100_000, priceCents: 8990, sortOrder: 2 } });
    expect(await sa.packUpdate(actor(), b.pack.id, { name: nm("A") })).toMatchObject({ ok: false, status: 409, code: "name_taken" });
    // Quedarse con su propio nombre no es conflicto, y repetir lo mismo no cambia nada.
    expect(await sa.packUpdate(actor(), b.pack.id, { name: nm("B2").toUpperCase() })).toMatchObject({ ok: true, changed: true });
    expect(await sa.packUpdate(actor(), b.pack.id, { coins: 1000 })).toMatchObject({ ok: true, changed: false });
    expect(await sa.packUpdate(actor(), "crk_no_existe", { active: false })).toMatchObject({ ok: false, status: 404 });
  });

  it("activar y desactivar: los clientes solo ven los activos, en el orden del catálogo", async () => {
    vi.stubEnv("CREDITS", "on");
    const x = await sa.packCreate(actor(), base("Orden10", { sortOrder: 10, priceCents: 1000 }));
    const y = await sa.packCreate(actor(), base("Orden1", { sortOrder: 1, priceCents: 9000 }));
    const z = await sa.packCreate(actor(), base("Orden1b", { sortOrder: 1, priceCents: 5000 }));
    if (!x.ok || !y.ok || !z.ok) throw new Error("x");

    const vistos = async () => (await sum.activePacks()).packs.filter((p) => p.name.startsWith(`Prueba ${tag} Orden`)).map((p) => p.name);
    // Mismo orden → el más barato primero; luego el de orden mayor.
    expect(await vistos()).toEqual([nm("Orden1b"), nm("Orden1"), nm("Orden10")]);

    await sa.packUpdate(actor(), y.pack.id, { active: false });
    expect(await vistos()).toEqual([nm("Orden1b"), nm("Orden10")]);
    // El Super Admin sí sigue viéndolo.
    expect((await sa.packsOverview()).find((p) => p.id === y.pack.id)?.active).toBe(false);
    await sa.packUpdate(actor(), y.pack.id, { active: true });
    expect(await vistos()).toHaveLength(3);
  });

  it("lo que ve el cliente es solo lo necesario: id, nombre, monedas y precio", async () => {
    const { packs } = await sum.activePacks();
    expect(packs.length).toBeGreaterThan(0);
    for (const p of packs) expect(Object.keys(p).sort()).toEqual(["currency", "id", "name", "priceCents", "units"]);
  });

  it("con CREDITS apagada el listado de clientes sale vacío (el catálogo sigue ahí)", async () => {
    vi.stubEnv("CREDITS", "");
    expect(await sum.activePacks()).toEqual({ enabled: false, packs: [] });
    expect((await sa.packsOverview()).length).toBeGreaterThan(0);
    vi.stubEnv("CREDITS", "on");
  });

  it("editar o desactivar un paquete NO altera una compra ya creada (copia unidades y precio)", async () => {
    const p = await sa.packCreate(actor(), base("Compra", { coins: 200, priceCents: 2500 }));
    if (!p.ok) throw new Error("x");
    const t = await c.createTopupIntent({ organizationId: orgId, packId: p.pack.id });
    if (t.status !== "created") throw new Error("x");
    expect(t.topup).toMatchObject({ units: 20_000, amountCents: 2500, currency: "PEN" });

    await sa.packUpdate(actor(), p.pack.id, { coins: 999, priceCents: 9999, active: false });
    const [despues] = await db.select().from(schema.creditTopup).where(eq(schema.creditTopup.id, t.topup.id));
    expect(despues).toMatchObject({ units: 20_000, amountCents: 2500 });
    // Y un paquete inactivo ya no se puede comprar.
    expect(await c.createTopupIntent({ organizationId: orgId, packId: p.pack.id })).toEqual({ status: "pack_not_found" });
  });

  it("cada cambio deja su rastro en la auditoría: quién, qué, antes y después", async () => {
    const p = await sa.packCreate(actor(), base("Audit", { coins: 100, priceCents: 1000 }));
    if (!p.ok) throw new Error("x");
    await sa.packUpdate(actor(), p.pack.id, { priceCents: 1500 });
    await sa.packUpdate(actor(), p.pack.id, { active: false });
    await sa.packUpdate(actor(), p.pack.id, { active: true });
    const rows = (await db.select().from(schema.superAdminAudit).where(eq(schema.superAdminAudit.actorUserId, adminId))).filter((r) => (r.after as { packId?: string } | null)?.packId === p.pack.id);
    expect(rows.map((r) => r.action).sort()).toEqual(["credit_pack.activate", "credit_pack.create", "credit_pack.deactivate", "credit_pack.update"]);
    const upd = rows.find((r) => r.action === "credit_pack.update")!;
    expect(upd).toMatchObject({ actorEmail: `k.${tag}@example.com`, ip: "10.0.0.9" });
    expect((upd.before as { priceCents: number }).priceCents).toBe(1000);
    expect((upd.after as { priceCents: number }).priceCents).toBe(1500);
    expect(rows.find((r) => r.action === "credit_pack.create")?.before).toBeNull();
  });

  it("el cambio y su rastro son una sola transacción: si el rastro no se puede escribir, el cambio tampoco ocurre", async () => {
    const antes = (await mine()).length;
    // Un usuario inexistente rompe la clave foránea de la auditoría.
    await expect(c.createPack({ name: nm("Atomico"), units: 100, priceCents: 100 }, { userId: "usr_no_existe" })).rejects.toThrow();
    expect((await mine()).length).toBe(antes);
    expect((await mine()).some((p) => p.name === nm("Atomico"))).toBe(false);
  });

  it("tope de paquetes: al llegar a 50 no se crean más (y no se pierde nada)", async () => {
    const hay = (await db.select().from(schema.creditPack)).length;
    const meter = lib.PACK_LIMITS.maxPacks - hay;
    if (meter < 0) return; // la base ya tiene más (no es nuestro caso): nada que probar
    for (let i = 0; i < meter; i++) await db.insert(schema.creditPack).values({ id: `crk_k${tag}${i}`, name: `Prueba ${tag} Relleno ${i}`, units: 100, priceCents: 100 });
    expect(await sa.packCreate(actor(), base("Sobra"))).toMatchObject({ ok: false, status: 409, code: "limit_reached" });
    // Desactivar no libera cupo (no se borra), pero editar sigue funcionando.
    const [uno] = await mine();
    expect(await sa.packUpdate(actor(), uno!.id, { sortOrder: 7 })).toMatchObject({ ok: true });
  });
});
