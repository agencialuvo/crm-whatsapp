import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * La zona horaria del negocio contra PostgreSQL REAL (`pnpm test:db`): lo elegido en Marca manda sobre
 * la agenda, sin elegir manda la de la agenda, cambiarla desde la agenda también la deja en la marca, y
 * una organización no afecta a la otra. Restaura la marca original al terminar.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("zona horaria contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let branding: typeof import("@/server/branding");
  let period: typeof import("@/server/analytics/period");
  let agenda: typeof import("@/server/agenda/settings");
  let tzSvc: typeof import("@/server/timezone");
  let orgA = "";
  let orgB = "";
  const originals = new Map<string, { metadata: string | null; row: unknown }>();

  beforeAll(async () => {
    ({ eq } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    branding = await import("@/server/branding");
    period = await import("@/server/analytics/period");
    agenda = await import("@/server/agenda/settings");
    tzSvc = await import("@/server/timezone");
    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    expect(orgs.length, "hacen falta dos organizaciones").toBeGreaterThanOrEqual(2);
    orgA = orgs[0]!.id;
    orgB = orgs[1]!.id;
    for (const org of [orgA, orgB]) {
      const [o] = await db.select({ metadata: schema.organization.metadata }).from(schema.organization).where(eq(schema.organization.id, org));
      const [row] = await db.select().from(schema.calendarSettings).where(eq(schema.calendarSettings.organizationId, org));
      originals.set(org, { metadata: o?.metadata ?? null, row: row ?? null });
    }
  });

  afterAll(async () => {
    if (!db) return;
    for (const [org, o] of originals) {
      await db.update(schema.organization).set({ metadata: o.metadata }).where(eq(schema.organization.id, org));
      const row = o.row as typeof schema.calendarSettings.$inferSelect | null;
      if (row) await db.update(schema.calendarSettings).set({ timezone: row.timezone }).where(eq(schema.calendarSettings.organizationId, org));
      else await db.delete(schema.calendarSettings).where(eq(schema.calendarSettings.organizationId, org));
    }
  });

  it("lo elegido en Marca manda en reportes y en la agenda, y no toca la otra organización", async () => {
    const antesB = await period.businessTimezone(orgB);
    await branding.saveBrandingTimezone(orgA, "America/Lima");
    expect(await period.businessTimezone(orgA)).toBe("America/Lima");
    expect((await agenda.getSettings(orgA)).timezone).toBe("America/Lima");
    expect(await period.businessTimezone(orgB)).toBe(antesB);
  });

  it("guardar la zona conserva nombre, color, moneda e icono de la marca", async () => {
    const antes = await branding.getBranding(orgA);
    await branding.saveBrandingTimezone(orgA, "America/Bogota");
    const despues = await branding.getBranding(orgA);
    expect(despues).toMatchObject({ name: antes.name, accent: antes.accent, currency: antes.currency, favicon: antes.favicon });
    expect(despues.timezone).toBe("America/Bogota");
  });

  it("cambiarla desde la agenda también la deja en la marca (una sola zona para todo)", async () => {
    await agenda.upsertSettings(orgA, { timezone: "America/Santiago" });
    expect(await period.businessTimezone(orgA)).toBe("America/Santiago");
    expect((await branding.getBranding(orgA)).timezone).toBe("America/Santiago");
  });

  it("una zona desconocida se rechaza y no cambia nada", async () => {
    await expect(agenda.upsertSettings(orgA, { timezone: "No/Existe" })).rejects.toThrow(/Zona horaria/);
    expect(await period.businessTimezone(orgA)).toBe("America/Santiago");
  });

  /** Deja al negocio sin zona elegida: sin zona en la marca y sin fila de agenda. */
  async function unconfigure(org: string) {
    const [o] = await db.select({ metadata: schema.organization.metadata }).from(schema.organization).where(eq(schema.organization.id, org));
    const meta = o?.metadata ? (JSON.parse(o.metadata) as { branding?: Record<string, unknown> }) : {};
    if (meta.branding) delete meta.branding.timezone;
    await db.update(schema.organization).set({ metadata: JSON.stringify(meta) }).where(eq(schema.organization.id, org));
    await db.delete(schema.calendarSettings).where(eq(schema.calendarSettings.organizationId, org));
  }

  it("sin zona elegida adopta la detectada (la del país del navegador)", async () => {
    await unconfigure(orgA);
    expect(await tzSvc.isTimezoneConfigured(orgA)).toBe(false);
    expect(await tzSvc.adoptDetectedTimezone(orgA, "America/Bogota")).toBe(true);
    expect(await period.businessTimezone(orgA)).toBe("America/Bogota");
    expect(await tzSvc.isTimezoneConfigured(orgA)).toBe(true);
  });

  it("nunca pisa una zona ya elegida", async () => {
    await branding.saveBrandingTimezone(orgA, "America/Lima");
    expect(await tzSvc.adoptDetectedTimezone(orgA, "Europe/Madrid")).toBe(false);
    expect(await period.businessTimezone(orgA)).toBe("America/Lima");
  });

  it("una zona ya guardada por la agenda cuenta como elegida", async () => {
    await unconfigure(orgA);
    await agenda.upsertSettings(orgA, { slotMinutes: 30 });
    expect(await tzSvc.isTimezoneConfigured(orgA)).toBe(true);
    expect(await tzSvc.adoptDetectedTimezone(orgA, "Europe/Madrid")).toBe(false);
  });

  it("una zona detectada desconocida se descarta", async () => {
    await unconfigure(orgA);
    expect(await tzSvc.adoptDetectedTimezone(orgA, "No/Existe")).toBe(false);
    expect(await tzSvc.adoptDetectedTimezone(orgA, "  ")).toBe(false);
    expect(await tzSvc.isTimezoneConfigured(orgA)).toBe(false);
  });
});
