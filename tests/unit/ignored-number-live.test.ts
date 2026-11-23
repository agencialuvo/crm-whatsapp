import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Los números ignorados contra PostgreSQL REAL: el índice único, el aislamiento por organización, el tope y el
 * borrado. Corre con `pnpm test:db`; sin `RUN_DB_TESTS` se salta.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("números ignorados (base real)", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let svc: typeof import("@/server/ai/ignored");
  let lib: typeof import("@/lib/ignored-number");

  const tag = Date.now().toString(36);
  const orgA = `org_ia${tag}`;
  const orgB = `org_ib${tag}`;

  beforeAll(async () => {
    ({ eq } = await import("drizzle-orm"));
    const dbLib = await import("@/lib/db");
    db = dbLib.getDb();
    schema = dbLib.schema;
    svc = await import("@/server/ai/ignored");
    lib = await import("@/lib/ignored-number");
    for (const [id, slug] of [[orgA, `ia-${tag}`], [orgB, `ib-${tag}`]] as const) {
      await db.insert(schema.organization).values({ id, name: `Org ${slug}`, slug });
    }
  });

  afterAll(async () => {
    if (!db) return;
    // La tabla cae en cascada con la organización.
    await db.delete(schema.organization).where(eq(schema.organization.id, orgA));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgB));
  });

  const wa = (phone: string) => ({ channel: "whatsapp" as const, waIdentity: phone, phone });

  it("agrega un número escrito a mano y lo reconoce en el contacto, escrito como sea", async () => {
    const r = await svc.addIgnored(orgA, { raw: "+52 1 55 1234 5678", label: "Mamá" });
    expect(r.status).toBe("added");
    if (r.status === "added") {
      expect(r.entry.key).toBe("525512345678");
      expect(r.entry.label).toBe("Mamá");
      expect(r.entry.channel).toBe("whatsapp");
    }
    // Meta puede reportarlo con el 1 de más; la identidad del contacto ya viene canonizada, o no.
    expect(await svc.isIgnoredContact(orgA, wa("525512345678"))).toBe(true);
    expect(await svc.isIgnoredContact(orgA, wa("5215512345678"))).toBe(true);
    expect(await svc.isIgnoredContact(orgA, wa("525599999999"))).toBe(false);
  });

  it("un duplicado no es un error ni crea otra fila", async () => {
    const r = await svc.addIgnored(orgA, { raw: "0052 55 1234 5678" });
    expect(r).toEqual({ status: "duplicate" });
    expect((await svc.listIgnored(orgA)).filter((e) => e.key === "525512345678")).toHaveLength(1);
  });

  it("rechaza sin tocar la base lo que no lleva código de país", async () => {
    const before = await svc.countIgnored(orgA);
    expect(await svc.addIgnored(orgA, { raw: "5512345678" })).toEqual({ status: "invalid", error: lib.NEEDS_COUNTRY_CODE });
    expect(await svc.addIgnored(orgA, { raw: "+51 987 654 321", label: "x".repeat(81) })).toMatchObject({ status: "invalid" });
    expect(await svc.countIgnored(orgA)).toBe(before);
  });

  it("la lista es de cada organización: la otra ni la ve ni la afecta", async () => {
    expect(await svc.isIgnoredContact(orgB, wa("525512345678"))).toBe(false);
    expect(await svc.listIgnored(orgB)).toEqual([]);
    const [entry] = await svc.listIgnored(orgA);
    expect(await svc.removeIgnored(orgB, entry!.id)).toBe(false);
    expect(await svc.isIgnoredContact(orgA, wa("525512345678"))).toBe(true);
  });

  it("la misma llave puede estar en otra organización y en otro canal", async () => {
    expect((await svc.addIgnored(orgB, { raw: "+52 55 1234 5678" })).status).toBe("added");
    const ig = await svc.addIgnored(orgA, { contact: { channel: "instagram", waIdentity: "ig:178414" } });
    expect(ig.status).toBe("added");
    expect(await svc.isIgnoredContact(orgA, { channel: "instagram", waIdentity: "ig:178414" })).toBe(true);
    // Una llave de un canal no vale en otro.
    expect(await svc.isIgnoredContact(orgA, { channel: "messenger", waIdentity: "ig:178414" })).toBe(false);
  });

  it("un contacto con BSUID y teléfono queda ignorado por cualquiera de los dos", async () => {
    await svc.addIgnored(orgA, { raw: "+51 987 654 321" });
    const porTelefono = { channel: "whatsapp" as const, waIdentity: "bsuid:ZZ99", phone: "51987654321", waUserId: "ZZ99" };
    expect(await svc.isIgnoredContact(orgA, porTelefono)).toBe(true);
    await svc.addIgnored(orgA, { contact: { channel: "whatsapp", waIdentity: "bsuid:QQ11", phone: null } });
    expect(await svc.isIgnoredContact(orgA, { channel: "whatsapp", waIdentity: "bsuid:QQ11", phone: null })).toBe(true);
  });

  it("agregar varios: reporta duplicados y respeta el tope", async () => {
    const parsed = lib.parseIgnoredInput(["+51 987 654 321", "+51 911 111 111, Tienda", "+51 922 222 222"].join("\n"));
    const r = await svc.addIgnoredMany(orgA, parsed.valid);
    expect(r.added.map((e) => e.key).sort()).toEqual(["51911111111", "51922222222"]);
    expect(r.duplicates.map((e) => e.key)).toEqual(["51987654321"]);
    expect(r.overLimit).toEqual([]);

    // Llena hasta el tope con números sintéticos y comprueba que ya no cabe uno más.
    const room = lib.IGNORED_LIMIT - (await svc.countIgnored(orgA));
    const filler = Array.from({ length: room }, (_, i) => ({ line: i + 1, key: `99${String(i).padStart(9, "0")}`, label: null }));
    expect((await svc.addIgnoredMany(orgA, filler)).added).toHaveLength(room);
    expect(await svc.countIgnored(orgA)).toBe(lib.IGNORED_LIMIT);
    expect(await svc.addIgnored(orgA, { raw: "+51 933 333 333" })).toEqual({ status: "limit", limit: lib.IGNORED_LIMIT });
    const extra = await svc.addIgnoredMany(orgA, [{ line: 1, key: "51933333333", label: null }]);
    expect(extra.overLimit).toHaveLength(1);
    expect(extra.added).toEqual([]);
  });

  it("quitar surte efecto de inmediato y no toca al contacto", async () => {
    const contactId = `ct_i${tag}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId: orgA, name: "Mamá", waIdentity: "525512345678", phone: "525512345678" });
    const [entry] = (await svc.listIgnored(orgA, { search: "5512345678" }));
    expect(entry!.key).toBe("525512345678");
    expect(await svc.removeIgnored(orgA, entry!.id)).toBe(true);
    expect(await svc.isIgnoredContact(orgA, wa("525512345678"))).toBe(false);
    expect(await svc.removeIgnored(orgA, entry!.id)).toBe(false);
    const [c] = await db.select().from(schema.contact).where(eq(schema.contact.id, contactId));
    expect(c!.aiPaused).toBe(false);
  });

  it("isConversationSilenced: de la conversación al contacto y a la lista, sin marcar nada", async () => {
    const contactId = `ct_s${tag}`;
    const convId = `cv_s${tag}`;
    await db.insert(schema.contact).values({ id: contactId, organizationId: orgA, name: "Papá", waIdentity: "5215588776655", phone: "5215588776655" });
    await db.insert(schema.conversation).values({ id: convId, organizationId: orgA, contactId, lastInboundAt: new Date() });

    expect(await svc.isConversationSilenced(orgA, convId)).toBe(false);
    // La prueba de «quitar» dejó un lugar libre bajo el tope.
    expect((await svc.addIgnored(orgA, { raw: "+52 55 8877 6655" })).status).toBe("added");
    expect(await svc.isConversationSilenced(orgA, convId)).toBe(true);
    // Otra organización no la ve, aunque pregunte por esa conversación.
    expect(await svc.isConversationSilenced(orgB, convId)).toBe(false);

    // Callar no deja marcas: ni pausa en el contacto, ni traspaso en la conversación.
    const [c] = await db.select().from(schema.contact).where(eq(schema.contact.id, contactId));
    const [cv] = await db.select().from(schema.conversation).where(eq(schema.conversation.id, convId));
    expect(c!.aiPaused).toBe(false);
    expect(cv!.aiEnabled).toBe(true);
    expect(cv!.handoffAt).toBeNull();

    const [entry] = await svc.listIgnored(orgA, { search: "5588776655" });
    await svc.removeIgnored(orgA, entry!.id);
    expect(await svc.isConversationSilenced(orgA, convId)).toBe(false);
  });

  it("isConversationSilenced con una conversación inexistente: no calla", async () => {
    expect(await svc.isConversationSilenced(orgA, "cv_no_existe")).toBe(false);
  });

  it("la búsqueda ignora los comodines de LIKE", async () => {
    expect(await svc.listIgnored(orgA, { search: "%" })).toHaveLength(await svc.countIgnored(orgA));
  });
});
