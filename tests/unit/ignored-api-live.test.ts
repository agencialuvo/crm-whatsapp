import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Números ignorados: las rutas contra PostgreSQL REAL, con la sesión simulada. Lo que los mocks no pueden probar:
 * que una organización no ve, no quita ni ignora a los contactos de otra, y que los dos endpoints del cerebro
 * externo se callan de verdad con un número de la lista. Corre con `pnpm test:db`.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const tag = Date.now().toString(36);
const ctx = vi.hoisted(() => ({
  session: { role: "owner", organizationId: "", userId: "" },
  botOrg: "",
}));

vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ ...ctx.session }),
  getSessionOrNull: async () => ({ ...ctx.session }),
}));
vi.mock("@/server/bot/auth", () => ({
  requireBotKey: () => null,
  resolveInstanceOrg: async () => ctx.botOrg,
}));

describe.skipIf(!live)("números ignorados: rutas (base real)", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];

  const orgA = `org_aa${tag}`;
  const orgB = `org_ab${tag}`;
  const ctA = `ct_aa${tag}`;
  const ctB = `ct_ab${tag}`;
  const cvA = `cv_aa${tag}`;
  const userId = `usr_ia${tag}`;

  const as = (org: string, role = "owner") => {
    ctx.session.organizationId = org;
    ctx.session.role = role;
    ctx.session.userId = userId;
    ctx.botOrg = org;
  };

  const req = (method: string, body?: unknown, url = "https://x/api/agent/ignored-numbers") =>
    new Request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const get = async (query = "") => (await import("@/app/api/agent/ignored-numbers/route")).GET(req("GET", undefined, `https://x/api/agent/ignored-numbers${query}`));
  const post = async (body: unknown) => (await import("@/app/api/agent/ignored-numbers/route")).POST(req("POST", body));
  const del = async (id: string) =>
    (await import("@/app/api/agent/ignored-numbers/[id]/route")).DELETE(req("DELETE"), { params: Promise.resolve({ id }) });

  beforeAll(async () => {
    ({ eq } = await import("drizzle-orm"));
    const lib = await import("@/lib/db");
    db = lib.getDb();
    schema = lib.schema;
    // El alta guarda quién la hizo (FK a user): con una cuenta real, como en producción.
    await db.insert(schema.user).values({ id: userId, name: "Dueño", email: `ia-${tag}@example.test` });
    for (const [id, slug] of [[orgA, `aa-${tag}`], [orgB, `ab-${tag}`]] as const) {
      await db.insert(schema.organization).values({ id, name: `Org ${slug}`, slug });
    }
    await db.insert(schema.contact).values({ id: ctA, organizationId: orgA, name: "Mamá", waIdentity: "51987654321", phone: "51987654321" });
    await db.insert(schema.contact).values({ id: ctB, organizationId: orgB, name: "Otro", waIdentity: "51900000000", phone: "51900000000" });
    await db.insert(schema.conversation).values({ id: cvA, organizationId: orgA, contactId: ctA, lastInboundAt: new Date() });
  });

  afterAll(async () => {
    if (!db) return;
    // Todo cuelga de la organización y cae en cascada.
    await db.delete(schema.organization).where(eq(schema.organization.id, orgA));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgB));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
  });

  it("alta, lectura y borrado de una organización, y la otra ni lo ve ni lo toca", async () => {
    as(orgA);
    const created = await post({ number: "+52 1 55 1234 5678", label: "Papá" });
    expect(created.status).toBe(201);
    const entry = (await created.json()).entry as { id: string; display: string; key: string };
    expect(entry).toMatchObject({ key: "525512345678", display: "+525512345678" });
    const [stored] = await db.select().from(schema.ignoredNumber).where(eq(schema.ignoredNumber.id, entry.id));
    expect(stored!.createdByUserId).toBe(userId);

    expect((await (await get()).json()).total).toBe(1);

    as(orgB);
    const seenByB = await (await get()).json();
    expect(seenByB).toMatchObject({ entries: [], total: 0 });
    expect((await del(entry.id)).status).toBe(404);

    as(orgA);
    expect((await (await get()).json()).total).toBe(1);
    expect((await del(entry.id)).status).toBe(200);
    expect((await (await get()).json()).total).toBe(0);
    expect((await del(entry.id)).status).toBe(404);
  });

  it("la misma persona puede estar en la lista de las dos organizaciones", async () => {
    as(orgA);
    expect((await post({ number: "+51 987 000 111" })).status).toBe(201);
    as(orgB);
    expect((await post({ number: "+51 987 000 111" })).status).toBe(201);
    expect((await post({ number: "+51 987 000 111" })).status).toBe(409);
  });

  it("un miembro del equipo lee pero no escribe", async () => {
    as(orgA, "member");
    expect((await get()).status).toBe(200);
    expect((await post({ number: "+51 987 000 222" })).status).toBe(403);
    expect((await (await get()).json()).entries.some((e: { key: string }) => e.key === "51987000222")).toBe(false);
  });

  it("pegar varios contra la base: agrega, avisa de duplicados e inválidos", async () => {
    as(orgA);
    const res = await post({ bulk: ["+51 987 000 111", "+51 911 222 333, Tienda", "5512345678", "+51 911 222 333"].join("\n") });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.added.map((e: { key: string }) => e.key)).toEqual(["51911222333"]);
    expect(out.duplicates.map((e: { key: string }) => e.key)).toEqual(["51987000111"]);
    expect(out.invalid.map((e: { line: number }) => e.line)).toEqual([3, 4]);
    expect(out.invalid[1].reason).toMatch(/Repetido/);
  });

  it("ignorar desde un contacto de la Bandeja: solo los de la propia organización", async () => {
    as(orgA);
    expect((await post({ contactId: ctB })).status).toBe(404);
    const res = await post({ contactId: ctA, label: "Mamá" });
    expect(res.status).toBe(201);
    expect((await res.json()).entry).toMatchObject({ key: "51987654321", channel: "whatsapp", label: "Mamá" });
    // Callar no toca al contacto: la lista es la fuente de verdad.
    const [c] = await db.select().from(schema.contact).where(eq(schema.contact.id, ctA));
    expect(c!.aiPaused).toBe(false);
  });

  it("?contactId= dice si ESE contacto está ignorado, y solo con los datos de la propia organización", async () => {
    as(orgA);
    const yes = await (await get(`?contactId=${ctA}`)).json();
    expect(yes).toMatchObject({ ignored: true, entry: { key: "51987654321", display: "+51987654321" } });
    // Otro contacto de la misma organización que nadie ignoró.
    const ctC = `ct_ac${tag}`;
    await db.insert(schema.contact).values({ id: ctC, organizationId: orgA, name: "Libre", waIdentity: "51955555555", phone: "51955555555" });
    expect(await (await get(`?contactId=${ctC}`)).json()).toEqual({ ignored: false, entry: null });
    // Un contacto de otra organización no existe para esta.
    expect((await get(`?contactId=${ctB}`)).status).toBe(404);
    // Y la otra organización no hereda el estado, aunque su teléfono coincida con uno ignorado aquí.
    as(orgB);
    expect(await (await get(`?contactId=${ctB}`)).json()).toEqual({ ignored: false, entry: null });
  });

  it("el cerebro externo: /api/bot/messages y /api/bot/typing se callan con ese contacto", async () => {
    as(orgA);
    const { POST: messages } = await import("@/app/api/bot/messages/route");
    const { POST: typing } = await import("@/app/api/bot/typing/route");

    const m = await messages(req("POST", { conversationId: cvA, text: "hola" }, "https://x/api/bot/messages"));
    expect(m.status).toBe(409);
    expect((await m.json()).error).toMatchObject({ code: "ai_paused", reason: "ignored_number" });

    const t = await typing(req("POST", { conversationId: cvA }, "https://x/api/bot/typing"));
    expect(await t.json()).toEqual({ ok: false, reason: "ai_paused", ignored: true });
  });

  it("al quitarlo de la lista el cerebro vuelve a poder hablar (la conversación nunca se pausó)", async () => {
    as(orgA);
    const list = (await (await get("?search=987654321")).json()).entries as { id: string }[];
    expect(list).toHaveLength(1);
    expect((await del(list[0]!.id)).status).toBe(200);

    const { POST: typing } = await import("@/app/api/bot/typing/route");
    const t = await (await typing(req("POST", { conversationId: cvA }, "https://x/api/bot/typing"))).json();
    // Ya no lo corta la lista: llega a buscar el último mensaje entrante (no hay ninguno).
    expect(t).toEqual({ ok: false, reason: "no_inbound" });
  });
});
