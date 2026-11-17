import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 041 — Envío robusto y reconciliación de estados, contra PostgreSQL REAL.
 *
 * Necesita una base con las migraciones aplicadas, así que NO corre con `pnpm test`: se enciende con
 *   RUN_DB_TESTS=1 corepack pnpm exec vitest run tests/unit/envio-robusto-live.test.ts
 * Crea sus propios datos y los borra al terminar. La Graph API se simula reemplazando `fetch`.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const holder = vi.hoisted(() => ({ org: "" }));

// Credenciales de WhatsApp falsas para la organización de prueba; el resto del módulo, intacto.
vi.mock("@/server/whatsapp/credentials", async (orig) => {
  const real = await orig<typeof import("@/server/whatsapp/credentials")>();
  return {
    ...real,
    getCredentialsByOrg: async () => ({
      organizationId: holder.org,
      phoneNumberId: "pn_envio_robusto",
      wabaId: "waba_envio_robusto",
      token: "token-falso",
      status: "connected",
    }),
  };
});

describe.skipIf(!live)("envío robusto contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let sql: (typeof import("drizzle-orm"))["sql"];
  let outbox: typeof import("@/server/inbox/outbox");
  let status: typeof import("@/server/inbox/status");
  let send: typeof import("@/server/inbox/send");
  let templates: typeof import("@/server/whatsapp/templates");

  const uid = Date.now().toString(36);
  let seq = 0;
  let otherOrg: string | null = null;
  const created = {
    contacts: [] as string[],
    convs: [] as string[],
    templates: [] as string[],
    waIds: [] as string[],
  };

  // La Graph simulada: `ok` acepta y devuelve un id; `fail` rechaza con un error de Meta.
  let graph: "ok" | "fail" = "ok";
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    ({ eq, inArray, sql } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    outbox = await import("@/server/inbox/outbox");
    status = await import("@/server/inbox/status");
    send = await import("@/server/inbox/send");
    templates = await import("@/server/whatsapp/templates");

    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    holder.org = orgs[0]!.id;
    otherOrg = orgs[1]?.id ?? null;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      // Solo se simula la Graph API; cualquier otra cosa sigue su camino.
      if (!/\/(messages|media)(\?|$)/.test(url)) return realFetch(input);
      fetchCalls++;
      if (graph === "fail") {
        return new Response(
          JSON.stringify({ error: { message: "(#131000) Something went wrong", code: 131000, type: "OAuthException" } }),
          { status: 400 }
        );
      }
      const id = /\/media/.test(url) ? "media-id-falso" : `wamid.${uid}.${seq++}`;
      if (!/\/media/.test(url)) created.waIds.push(id);
      return new Response(JSON.stringify(/\/media/.test(url) ? { id } : { messages: [{ id }] }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    graph = "ok";
    fetchCalls = 0;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (!db) return;
    if (created.waIds.length) {
      await db.delete(schema.messageStatusOrphan).where(inArray(schema.messageStatusOrphan.waMessageId, created.waIds));
    }
    if (created.templates.length) await db.delete(schema.template).where(inArray(schema.template.id, created.templates));
    if (created.convs.length) await db.delete(schema.conversation).where(inArray(schema.conversation.id, created.convs));
    if (created.contacts.length) await db.delete(schema.contact).where(inArray(schema.contact.id, created.contacts));
  });

  /** Un contacto con su chat real de WhatsApp. `inboundAgoMs` null = sin entrantes (ventana cerrada). */
  async function mkChat(opts: { inboundAgoMs?: number | null; isTest?: boolean } = {}) {
    const n = seq++;
    const contactId = `ct_er${uid}${n}`;
    const conversationId = `cv_er${uid}${n}`;
    const ago = opts.inboundAgoMs === undefined ? 0 : opts.inboundAgoMs;
    await db.insert(schema.contact).values({
      id: contactId,
      organizationId: holder.org,
      name: "Cliente Envío",
      waIdentity: `er-${uid}${n}`,
      phone: `52155577${String(n).padStart(4, "0")}`,
    });
    await db.insert(schema.conversation).values({
      id: conversationId,
      organizationId: holder.org,
      contactId,
      isTest: opts.isTest ?? false,
      lastInboundAt: ago === null ? null : new Date(Date.now() - ago),
    });
    created.contacts.push(contactId);
    created.convs.push(conversationId);
    return { contactId, conversationId };
  }

  const wamid = () => {
    const id = `wamid.test.${uid}.${seq++}`;
    created.waIds.push(id);
    return id;
  };

  const webhook = (id: string, st: string) => status.applyStatusUpdate(holder.org, { id, status: st, timestamp: "0" });

  async function filaDe(messageId: string) {
    const [m] = await db.select().from(schema.message).where(eq(schema.message.id, messageId));
    return m!;
  }
  async function huerfano(id: string) {
    const rows = await db.select().from(schema.messageStatusOrphan).where(eq(schema.messageStatusOrphan.waMessageId, id));
    return rows[0] ?? null;
  }
  async function mensajes(conversationId: string) {
    return db.select().from(schema.message).where(eq(schema.message.conversationId, conversationId));
  }
  const intento = (conversationId: string) =>
    outbox.registrarIntento(holder.org, conversationId, { type: "text", text: "hola", origin: "operator" });

  it("1. un estado que llega antes que el id se aplica al guardarlo", async () => {
    const { conversationId } = await mkChat();
    const fila = await intento(conversationId);
    const id = wamid();

    await webhook(id, "delivered"); // el mensaje aún no tiene id
    expect((await huerfano(id))?.status).toBe("delivered");
    expect((await filaDe(fila.id)).status).toBe("pending");

    expect(await outbox.confirmarEnvio(fila, id, "pending")).toBe(true);
    const m = await filaDe(fila.id);
    expect(m.waMessageId).toBe(id);
    expect(m.status).toBe("delivered");
    expect(await huerfano(id)).toBeNull();
  });

  it("2a. el emisor guarda el id mientras el webhook estaciona: el estado no se pierde", async () => {
    const { conversationId } = await mkChat();
    const fila = await intento(conversationId);
    const id = wamid();
    await status.applyStatusUpdate(
      holder.org,
      { id, status: "delivered", timestamp: "0" },
      // Justo después de estacionar y antes de volver a buscar, llega el emisor.
      { afterPark: async () => void (await outbox.confirmarEnvio(fila, id, "pending")) }
    );
    expect((await filaDe(fila.id)).status).toBe("delivered");
    expect(await huerfano(id)).toBeNull();
  });

  it("2b. el emisor guarda el id ANTES de que el webhook estacione: el webhook lo encuentra", async () => {
    const { conversationId } = await mkChat();
    const fila = await intento(conversationId);
    const id = wamid();
    await outbox.confirmarEnvio(fila, id, "pending");
    await webhook(id, "read");
    expect((await filaDe(fila.id)).status).toBe("read");
    expect(await huerfano(id)).toBeNull();
  });

  it("3. 300 carreras aleatorias entre el webhook y la confirmación: ninguna pierde el estado", async () => {
    const { conversationId } = await mkChat();
    const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 6)));
    const trials = Array.from({ length: 300 }, async (_, i) => {
      const fila = await intento(conversationId);
      const id = wamid();
      const esperado = i % 2 === 0 ? "delivered" : "read";
      await Promise.all([
        (async () => {
          await jitter();
          // Un estado menor y el definitivo, como Meta los manda.
          if (esperado === "read") await webhook(id, "sent");
          await webhook(id, esperado);
        })(),
        (async () => {
          await jitter();
          await outbox.confirmarEnvio(fila, id, "pending");
        })(),
      ]);
      return { fila, id, esperado };
    });
    const results = await Promise.all(trials);
    const filas = await db
      .select({ id: schema.message.id, status: schema.message.status })
      .from(schema.message)
      .where(inArray(schema.message.id, results.map((r) => r.fila.id)));
    const porId = new Map(filas.map((f) => [f.id, f.status]));
    const malos = results.filter((r) => porId.get(r.fila.id) !== r.esperado);
    expect(malos.length, JSON.stringify(malos.slice(0, 3))).toBe(0);
    const vivos = await db
      .select({ id: schema.messageStatusOrphan.id })
      .from(schema.messageStatusOrphan)
      .where(inArray(schema.messageStatusOrphan.waMessageId, results.map((r) => r.id)));
    expect(vivos.length).toBe(0);
  }, 60_000);

  it("4. delivered y read simultáneos terminan siempre en read; un sent tardío no degrada; failed aplica una vez", async () => {
    const { conversationId } = await mkChat();
    for (let i = 0; i < 100; i++) {
      const fila = await intento(conversationId);
      const id = wamid();
      await outbox.confirmarEnvio(fila, id, "pending");
      await Promise.all(i % 2 ? [webhook(id, "delivered"), webhook(id, "read")] : [webhook(id, "read"), webhook(id, "delivered")]);
      expect((await filaDe(fila.id)).status, `iteración ${i}`).toBe("read");
    }
    const fila = await intento(conversationId);
    const id = wamid();
    await outbox.confirmarEnvio(fila, id, "pending");
    await webhook(id, "read");
    await webhook(id, "sent");
    expect((await filaDe(fila.id)).status).toBe("read");
    await webhook(id, "failed");
    const caida = await filaDe(fila.id);
    expect(caida.status).toBe("failed");
    await webhook(id, "read"); // un failed no se levanta
    expect((await filaDe(fila.id)).status).toBe("failed");
  }, 60_000);

  it("4b. la regla en SQL coincide con isUpgrade para TODAS las parejas de estados", async () => {
    const { conversationId } = await mkChat();
    const todos = ["pending", "sent", "delivered", "read", "failed"] as const;
    for (const actual of todos) {
      for (const siguiente of ["sent", "delivered", "read", "failed"] as const) {
        const id = wamid();
        const [m] = await db
          .insert(schema.message)
          .values({
            id: `msg_p${uid}${seq++}`,
            organizationId: holder.org,
            conversationId,
            waMessageId: id,
            direction: "out",
            type: "text",
            text: "x",
            status: actual,
          })
          .returning();
        await webhook(id, siguiente);
        const despues = (await filaDe(m!.id)).status;
        expect(despues, `${actual} → ${siguiente}`).toBe(status.isUpgrade(actual, siguiente) ? siguiente : actual);
      }
    }
  });

  it("5. el búfer guarda un estado por mensaje: el de mayor rango; failed gana", async () => {
    const { conversationId } = await mkChat();
    const id = wamid();
    await webhook(id, "sent");
    await webhook(id, "read");
    await webhook(id, "delivered");
    expect((await huerfano(id))?.status).toBe("read");
    await webhook(id, "failed");
    expect((await huerfano(id))?.status).toBe("failed");
    await webhook(id, "read");
    expect((await huerfano(id))?.status).toBe("failed");
    // y se aplica entero al llegar el mensaje
    const fila = await intento(conversationId);
    await outbox.confirmarEnvio(fila, id, "pending");
    expect((await filaDe(fila.id)).status).toBe("failed");
  });

  it("6. todo tipo de envío que falla en Graph deja una burbuja failed con el motivo y su messageId", async () => {
    const { conversationId } = await mkChat();
    const org = holder.org;
    graph = "fail";

    const casos: [string, () => Promise<unknown>][] = [
      ["text", () => send.sendText({ conversationId, organizationId: org, text: "hola" })],
      ["location", () => send.sendStructured({ conversationId, organizationId: org, kind: "location", location: { latitude: 21, longitude: -101 } })],
      ["contacts", () => send.sendStructured({ conversationId, organizationId: org, kind: "contacts", contacts: [{ name: "Ana", phone: "5215512345678" }] })],
      [
        "image",
        () =>
          send.sendMediaMessage({
            conversationId,
            organizationId: org,
            file: { data: Buffer.from("89504e470d0a1a0a", "hex"), mimeType: "image/png", fileName: "x.png" },
          }),
      ],
    ];
    const tpl = `tpl_er${uid}`;
    await db.insert(schema.template).values({
      id: tpl, organizationId: org, name: `er_${uid}`, language: "es_MX", category: "UTILITY", body: "Hola {{1}}", status: "approved",
    });
    created.templates.push(tpl);
    casos.push(["template", () => templates.sendTemplate({ organizationId: org, conversationId, templateId: tpl, variables: ["Ana"] })]);

    for (const [tipo, run] of casos) {
      const err = await run().then(() => null, (e: unknown) => e);
      expect(err, tipo).toBeInstanceOf(send.SendError);
      expect((err as { messageId?: string }).messageId, tipo).toBeTruthy();
    }
    const filas = await mensajes(conversationId);
    expect(filas.length).toBe(5);
    for (const f of filas) {
      expect(f.status, f.type).toBe("failed");
      expect(f.error, f.type).toBeTruthy();
      expect(f.waMessageId).toBeNull();
    }
    // La ubicación fallida conserva su contenido: la burbuja muestra qué se quiso mandar.
    const ubic = filas.find((f) => f.type === "location")!;
    expect(ubic.mediaAssetId).toBeTruthy();
  });

  it("6b. un rechazo del pre-vuelo no deja burbuja ni llama a Graph", async () => {
    const { conversationId } = await mkChat({ inboundAgoMs: 30 * 3_600_000 }); // ventana de 24 h cerrada
    const err = await send.sendText({ conversationId, organizationId: holder.org, text: "hola" }).then(() => null, (e: unknown) => e);
    expect((err as { code?: string }).code).toBe("window_closed");
    expect(await mensajes(conversationId)).toHaveLength(0);
    expect(fetchCalls).toBe(0);

    const prueba = await mkChat({ isTest: true });
    const err2 = await send.sendText({ conversationId: prueba.conversationId, organizationId: holder.org, text: "hola" }).then(() => null, (e: unknown) => e);
    expect((err2 as { code?: string }).code).toBe("sandbox_violation");
    expect(await mensajes(prueba.conversationId)).toHaveLength(0);
  });

  it("6c. un envío que sale bien deja una sola fila con su id y en pending", async () => {
    const { conversationId } = await mkChat();
    const { messageId } = await send.sendText({ conversationId, organizationId: holder.org, text: "hola" });
    const filas = await mensajes(conversationId);
    expect(filas).toHaveLength(1);
    expect(filas[0]!.id).toBe(messageId);
    expect(filas[0]!.status).toBe("pending");
    expect(filas[0]!.waMessageId).toMatch(/^wamid\./);
  });

  it("7. si la base falla al guardar el id se reintenta; agotados los intentos queda constancia y la fila no se pierde", async () => {
    const { conversationId } = await mkChat();
    const fila = await intento(conversationId);

    let llamadas = 0;
    const flaky = async () => {
      if (++llamadas < 3) throw new Error("base caída");
      return true;
    };
    expect(await outbox.confirmarEnvio(fila, wamid(), "pending", { esperas: [0, 0, 0], guardarId: flaky })).toBe(true);
    expect(llamadas).toBe(3);

    const fila2 = await intento(conversationId);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = wamid();
    expect(
      await outbox.confirmarEnvio(fila2, id, "pending", {
        esperas: [0, 0, 0],
        guardarId: async () => {
          throw new Error("base caída");
        },
      })
    ).toBe(false);
    expect(spy.mock.calls.some((c) => String(c[0]).includes(id))).toBe(true);
    spy.mockRestore();
    const m = await filaDe(fila2.id);
    expect(m.status).toBe("pending");
    expect(m.waMessageId).toBeNull();
  });

  it("8. la barredera voltea lo viejo sin id y deja lo demás; dos pasadas no repiten", async () => {
    const real = await mkChat();
    const prueba = await mkChat({ isTest: true });
    const vieja = await intento(real.conversationId);
    const reciente = await intento(real.conversationId);
    const conId = await intento(real.conversationId);
    await outbox.confirmarEnvio(conId, wamid(), "pending");
    const deLab = await outbox.registrarIntento(holder.org, prueba.conversationId, { type: "text", text: "x", origin: "ai" });
    // Envejecer a mano: la vieja, la que ya tiene id y la del Laboratorio.
    await db.execute(sql`update message set created_at = now() - interval '10 minutes' where id in (${vieja.id}, ${conId.id}, ${deLab.id})`);

    const r1 = await outbox.sweepOutbox({ olderThanMs: 180_000 });
    expect(r1.rescued).toBeGreaterThanOrEqual(1);
    const m = await filaDe(vieja.id);
    expect(m.status).toBe("failed");
    expect(m.error).toBe(outbox.SIN_CONFIRMAR);
    expect((await filaDe(reciente.id)).status).toBe("pending");
    expect((await filaDe(conId.id)).status).toBe("pending"); // tiene id: lo cierra su acuse
    expect((await filaDe(deLab.id)).status).toBe("pending"); // el Laboratorio no se toca

    const r2 = await outbox.sweepOutbox({ olderThanMs: 180_000 });
    expect(r2.rescued).toBe(0);
  });

  it("8b. la barredera poda los huérfanos de más de 24 h y respeta los recientes", async () => {
    const viejo = wamid();
    const nuevo = wamid();
    await webhook(viejo, "delivered");
    await webhook(nuevo, "delivered");
    await db.execute(sql`update message_status_orphan set received_at = now() - interval '25 hours' where wa_message_id = ${viejo}`);
    const r = await outbox.sweepOutbox({ olderThanMs: 180_000 });
    expect(r.purged).toBeGreaterThanOrEqual(1);
    expect(await huerfano(viejo)).toBeNull();
    expect(await huerfano(nuevo)).not.toBeNull();
  });

  it("9. un estado de otra organización no toca el mensaje de esta", async () => {
    if (!otherOrg) return; // la base de pruebas tiene una sola organización
    const { conversationId } = await mkChat();
    const fila = await intento(conversationId);
    const id = wamid();
    await outbox.confirmarEnvio(fila, id, "pending");
    await status.applyStatusUpdate(otherOrg, { id, status: "read", timestamp: "0" });
    expect((await filaDe(fila.id)).status).toBe("pending");
    // Se estaciona bajo la otra organización: no se aplica jamás a este mensaje.
    await outbox.confirmarEnvio(fila, id, "pending");
    expect((await filaDe(fila.id)).status).toBe("pending");
  });
});
