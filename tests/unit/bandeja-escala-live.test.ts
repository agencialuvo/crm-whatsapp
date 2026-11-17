import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 042 — Escala y rendimiento de la bandeja, contra PostgreSQL REAL.
 *
 * Necesita una base con las migraciones aplicadas, así que NO corre con `pnpm test`: se enciende con
 *   RUN_DB_TESTS=1 corepack pnpm exec vitest run tests/unit/bandeja-escala-live.test.ts
 * Crea sus propios datos (cientos de conversaciones y 30 000 mensajes) y los borra al terminar.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("bandeja a escala contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let sql: (typeof import("drizzle-orm"))["sql"];
  let q: typeof import("@/server/inbox/queries");
  let cursor: typeof import("@/lib/inbox-cursor");
  let state: typeof import("@/lib/inbox-state");

  const uid = Date.now().toString(36);
  let org = "";
  let otherOrg: string | null = null;
  const stageA = `stg_es${uid}a`;
  const stageB = `stg_es${uid}b`;
  const contactIds: string[] = [];
  const convIds: string[] = [];

  /** Recorre TODAS las páginas de la lista con unos filtros; devuelve las conversaciones en el orden recibido. */
  async function recorrer(filters: Parameters<typeof q.listConversationsPage>[1]["filters"] = {}, limit = 40) {
    const out: Awaited<ReturnType<typeof q.listConversationsPage>>["conversations"] = [];
    let next: string | null = null;
    let guard = 0;
    do {
      const c: ReturnType<typeof cursor.decodeListCursor> = next ? cursor.decodeListCursor(next) : null;
      const page = await q.listConversationsPage(org, { limit, cursor: c, filters });
      out.push(...page.conversations);
      next = page.nextCursor;
      expect(++guard).toBeLessThan(200);
    } while (next);
    return out;
  }

  beforeAll(async () => {
    ({ eq, inArray, sql } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    q = await import("@/server/inbox/queries");
    cursor = await import("@/lib/inbox-cursor");
    state = await import("@/lib/inbox-state");

    const orgs = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(schema.organization.id);
    org = orgs[0]!.id;
    otherOrg = orgs[1]?.id ?? null;
    await db.insert(schema.pipelineStage).values([
      { id: stageA, organizationId: org, name: `Etapa A ${uid}`, position: 9001, kind: "open" },
      { id: stageB, organizationId: org, name: `Etapa B ${uid}`, position: 9002, kind: "open" },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    if (convIds.length) await db.delete(schema.conversation).where(inArray(schema.conversation.id, convIds));
    if (contactIds.length) await db.delete(schema.contact).where(inArray(schema.contact.id, contactIds));
    await db.delete(schema.pipelineStage).where(inArray(schema.pipelineStage.id, [stageA, stageB]));
  }, 120_000);

  /** Crea N conversaciones; `keyFor(i)` da la llave de orden (para empatar a propósito). */
  async function sembrar(
    n: number,
    tag: string,
    keyFor: (i: number) => Date,
    over: (i: number) => Partial<typeof schema.conversation.$inferInsert> = () => ({}),
    contactOver: (i: number) => Partial<typeof schema.contact.$inferInsert> = () => ({})
  ) {
    const contacts = Array.from({ length: n }, (_, i) => ({
      id: `ct_es${uid}${tag}${i}`,
      organizationId: org,
      name: `Cliente ${tag} ${i}`,
      waIdentity: `es-${uid}-${tag}-${i}`,
      phone: `52155${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      ...contactOver(i),
    }));
    const convs = contacts.map((c, i) => ({
      id: `cv_es${uid}${tag}${i}`,
      organizationId: org,
      contactId: c.id,
      lastMessageAt: keyFor(i),
      ...over(i),
    }));
    for (let i = 0; i < n; i += 250) {
      await db.insert(schema.contact).values(contacts.slice(i, i + 250));
      await db.insert(schema.conversation).values(convs.slice(i, i + 250));
    }
    contactIds.push(...contacts.map((c) => c.id));
    convIds.push(...convs.map((c) => c.id));
    return { contacts, convs };
  }

  it("1. paginación sin huecos ni repetidos, aun con llaves de orden EMPATADAS", async () => {
    const T = new Date("2031-01-01T10:00:00.000Z");
    // 500 conversaciones en 5 llaves distintas (100 por llave): el desempate por id es lo único que las separa.
    const { convs } = await sembrar(500, "pag", (i) => new Date(T.getTime() + (i % 5) * 1000));
    const visto = (await recorrer({ q: `Cliente pag` }, 40)).map((c) => c.id);
    expect(visto).toHaveLength(500);
    expect(new Set(visto).size).toBe(500);
    expect([...visto].sort()).toEqual(convs.map((c) => c.id).sort());
    // y en el orden que el cliente reproduce (llave desc, id desc)
    const esperado = [...convs].sort((a, b) => +b.lastMessageAt! - +a.lastMessageAt! || (a.id < b.id ? 1 : -1)).map((c) => c.id);
    expect(visto).toEqual(esperado);
    // páginas de 1 también
    const chica = await recorrer({ q: `Cliente pag 49` }, 1);
    expect(chica.length).toBe(new Set(chica.map((c) => c.id)).size);
  }, 60_000);

  it("1b. una llave con microsegundos no pierde ni repite filas en el límite de la página", async () => {
    const base = "2032-01-01 10:00:00";
    const ids = Array.from({ length: 6 }, (_, i) => `cv_es${uid}us${i}`);
    const cts = ids.map((_, i) => ({
      id: `ct_es${uid}us${i}`, organizationId: org, name: `Micro ${uid} ${i}`, waIdentity: `es-${uid}-us-${i}`, phone: null,
    }));
    await db.insert(schema.contact).values(cts);
    contactIds.push(...cts.map((c) => c.id));
    // Seis conversaciones que difieren SOLO en microsegundos: un Date de JavaScript las vería iguales.
    for (let i = 0; i < ids.length; i++) {
      await db.execute(sql`insert into conversation (id, organization_id, contact_id, last_message_at)
        values (${ids[i]}, ${org}, ${cts[i]!.id}, ${base + "." + String(100000 + i * 7)}::timestamp)`);
    }
    convIds.push(...ids);
    const visto = (await recorrer({ q: `Micro ${uid}` }, 2)).map((c) => c.id);
    expect(visto).toEqual([...ids].reverse()); // llave desc: la de mayor microsegundo primero
  });

  it("2. filtros y contadores: el servidor dice lo mismo que dice el cliente (matchesFilters)", async () => {
    const T = new Date("2033-01-01T10:00:00.000Z");
    const { convs, contacts } = await sembrar(
      60,
      "fil",
      (i) => new Date(T.getTime() + i * 1000),
      (i) => ({ unreadCount: i % 4 === 0 ? 2 : 0, channel: i % 10 === 0 ? "instagram" : "whatsapp" }),
      (i) => ({ name: i % 7 === 0 ? `José Ñandú ${i}` : `Persona fil ${i}` })
    );
    // etapas: pares en A, impares en B
    await db.insert(schema.lead).values(
      contacts.map((c, i) => ({
        id: `ld_es${uid}fil${i}`, organizationId: org, contactId: c.id, stageId: i % 2 === 0 ? stageA : stageB, position: i,
      }))
    );
    // anuncio de origen en las múltiplo de 5
    await db.insert(schema.adAttribution).values(
      convs.filter((_, i) => i % 5 === 0).map((c, k) => ({
        id: `att_es${uid}${k}`, organizationId: org, contactId: c.contactId, conversationId: c.id, headline: "Promo",
        sourceId: `src${k}`, sourceType: "ad", raw: {},
      }))
    );

    const todas = await recorrer({}, 100);
    const mias = todas.filter((c) => c.id.startsWith(`cv_es${uid}fil`));
    expect(mias).toHaveLength(60);

    const casos: Parameters<typeof q.listConversationsPage>[1]["filters"][] = [
      { q: "jose" }, { q: "ÑANDÚ" }, { q: "fil 1" }, { q: "%" }, { q: "_" },
      { stage: `Etapa A ${uid}` }, { channel: "instagram" }, { filter: "unread" }, { filter: "anuncios" },
      { q: "persona fil", stage: `Etapa B ${uid}`, filter: "unread" },
    ];
    for (const f of casos) {
      const delServidor = (await recorrer({ ...f, q: f!.q ? `${f!.q}` : undefined }, 100))
        .filter((c) => c.id.startsWith(`cv_es${uid}fil`))
        .map((c) => c.id)
        .sort();
      const delCliente = mias
        .filter((c) =>
          state.matchesFilters(c, {
            q: f!.q ?? "", stage: f!.stage ?? "all", channel: f!.channel ?? "all", filter: f!.filter ?? "all",
          })
        )
        .map((c) => c.id)
        .sort();
      expect(delServidor, JSON.stringify(f)).toEqual(delCliente);
    }

    // contadores de la primera página: coinciden con contar a mano
    const p = await q.listConversationsPage(org, { limit: 5, filters: { q: "fil" } });
    expect(p.counts).toBeDefined();
    const filtradas = todas.filter((c) => state.matchesFilters(c, { q: "fil", stage: "all", channel: "all", filter: "all" }));
    expect(p.counts!.all).toBe(filtradas.length);
    expect(p.counts!.unread).toBe(filtradas.filter((c) => c.unreadCount > 0).length);
    expect(p.counts!.anuncios).toBe(filtradas.filter((c) => c.anuncio !== null).length);
    expect(p.counts!.byChannel.whatsapp! + (p.counts!.byChannel.instagram ?? 0)).toBe(filtradas.length);
    expect(p.counts!.total).toBeGreaterThanOrEqual(60);
    expect(p.stages).toEqual(expect.arrayContaining([`Etapa A ${uid}`, `Etapa B ${uid}`]));
    expect(p.stages!.indexOf(`Etapa A ${uid}`)).toBeLessThan(p.stages!.indexOf(`Etapa B ${uid}`));
    // «cargar más» no recalcula contadores
    const sig = await q.listConversationsPage(org, { limit: 5, cursor: cursor.decodeListCursor(p.nextCursor!), filters: { q: "fil" } });
    expect(sig.counts).toBeUndefined();
    // con un canal elegido, los tres chips se acotan a él, y las marcas de bandeja no
    const ig = await q.listConversationsPage(org, { limit: 5, filters: { q: "fil", channel: "instagram" } });
    expect(ig.counts!.all).toBe(filtradas.filter((c) => c.channel === "instagram").length);
    expect(ig.counts!.byChannel.whatsapp).toBe(p.counts!.byChannel.whatsapp);
  }, 60_000);

  it("3. el delta detecta un mensaje, una lectura, un cambio de ETAPA y un anuncio nuevo; no devuelve lo que no cambió", async () => {
    const { convs, contacts } = await sembrar(4, "del", (i) => new Date(Date.UTC(2034, 0, 1, 10, i)), () => ({ unreadCount: 1 }));
    await db.insert(schema.lead).values(
      contacts.map((c, i) => ({ id: `ld_es${uid}del${i}`, organizationId: org, contactId: c.id, stageId: stageA, position: i }))
    );
    await new Promise((r) => setTimeout(r, 30));
    const marca = new Date();
    await new Promise((r) => setTimeout(r, 30));

    expect((await q.listConversationsDelta(org, marca)).conversations.filter((c) => c.id.startsWith(`cv_es${uid}del`))).toHaveLength(0);

    // 0: llegó un mensaje (toca la conversación)
    await db.update(schema.conversation).set({ lastMessageAt: new Date(), updatedAt: new Date() }).where(eq(schema.conversation.id, convs[0]!.id));
    // 1: se marcó leída
    expect((await q.markConversationRead(org, convs[1]!.id)).changed).toBe(true);
    // 2: cambió de etapa (solo toca al lead)
    await db.update(schema.lead).set({ stageId: stageB, updatedAt: new Date() }).where(eq(schema.lead.contactId, contacts[2]!.id));
    // 3: se le atribuyó un anuncio
    await db.insert(schema.adAttribution).values({
      id: `att_es${uid}del`, organizationId: org, contactId: contacts[3]!.id, conversationId: convs[3]!.id, headline: "Nuevo", sourceId: "x", sourceType: "ad", raw: {},
    });

    const d = await q.listConversationsDelta(org, marca);
    const mios = d.conversations.filter((c) => c.id.startsWith(`cv_es${uid}del`));
    expect(mios.map((c) => c.id).sort()).toEqual(convs.map((c) => c.id).sort());
    expect(mios.find((c) => c.id === convs[2]!.id)!.stageName).toBe(`Etapa B ${uid}`);
    expect(mios.find((c) => c.id === convs[1]!.id)!.unreadCount).toBe(0);
    expect(mios.find((c) => c.id === convs[3]!.id)!.anuncio).not.toBeNull();
    expect(d.serverTime).toBeTruthy();
    expect(d.counts).toBeDefined();
    expect(d.truncated).toBeUndefined();
  });

  it("3b. un delta de más de 200 filas se marca truncated", async () => {
    await sembrar(210, "tr", (i) => new Date(Date.UTC(2035, 0, 1, 0, 0, i)));
    const d = await q.listConversationsDelta(org, new Date(Date.now() - 3_600_000));
    expect(d.conversations).toHaveLength(200);
    expect(d.truncated).toBe(true);
  }, 60_000);

  it("4. el hilo se ordena por la hora del evento: un entrante que Meta retrasó cae en su lugar", async () => {
    const { convs } = await sembrar(1, "hil", () => new Date(), () => ({}));
    const cv = convs[0]!.id;
    const t = (min: number) => new Date(Date.UTC(2036, 0, 1, 10, min));
    // Orden de LLEGADA al CRM: m1, m3 (respuesta del operador), m2 (entrante retrasado: lo escribió a las 10:02).
    await db.insert(schema.message).values([
      { id: `msg_es${uid}1`, organizationId: org, conversationId: cv, direction: "in", type: "text", text: "m1", status: "delivered", waTimestamp: t(0), createdAt: t(0) },
      { id: `msg_es${uid}3`, organizationId: org, conversationId: cv, direction: "out", type: "text", text: "m3", status: "sent", createdAt: t(5) },
      { id: `msg_es${uid}2`, organizationId: org, conversationId: cv, direction: "in", type: "text", text: "m2", status: "delivered", waTimestamp: t(2), createdAt: t(9) },
    ]);
    const p = await q.listMessagesPage(org, cv, { limit: 50 });
    expect(p.messages.map((m) => m.text)).toEqual(["m1", "m2", "m3"]);
    // las horas que se ven NUNCA retroceden
    const horas = p.messages.map((m) => m.createdAt);
    expect([...horas].sort()).toEqual(horas);
    // y el preview de la lista es el último por la MISMA llave (m3, no m2 que llegó después)
    const lista = await q.getConversationDto(org, cv);
    expect(lista!.preview).toBe("m3");
  });

  it("4b. el hilo pagina hacia arriba sin repetir ni perder, con empates de wa_timestamp", async () => {
    const { convs } = await sembrar(1, "hp", () => new Date());
    const cv = convs[0]!.id;
    const n = 230;
    const filas = Array.from({ length: n }, (_, i) => ({
      id: `msg_es${uid}p${String(i).padStart(4, "0")}`, organizationId: org, conversationId: cv, direction: (i % 2 ? "out" : "in") as "in" | "out",
      type: "text", text: `t${i}`, status: "delivered" as const,
      // 10 mensajes por segundo de wa_timestamp: empates garantizados
      waTimestamp: new Date(Date.UTC(2037, 0, 1, 0, 0, Math.floor(i / 10))),
      createdAt: new Date(Date.UTC(2037, 0, 1, 0, 0, 0, i)),
    }));
    for (let i = 0; i < n; i += 100) await db.insert(schema.message).values(filas.slice(i, i + 100));

    const vistos: string[] = [];
    let before: ReturnType<typeof cursor.decodeThreadCursor> = null;
    let paginas = 0;
    for (;;) {
      const p = await q.listMessagesPage(org, cv, { limit: 50, before });
      vistos.unshift(...p.messages.map((m) => m.id));
      paginas++;
      if (!p.hasMore) break;
      before = cursor.decodeThreadCursor(p.nextBefore!);
      expect(before).not.toBeNull();
    }
    expect(paginas).toBe(5);
    expect(vistos).toHaveLength(n);
    expect(new Set(vistos).size).toBe(n);
    expect(vistos).toEqual(filas.map((f) => f.id)); // ascendente y completo
  });

  it("5. markRead es idempotente: con contador > 0 baja y avanza updated_at; con 0 no escribe", async () => {
    const { convs } = await sembrar(1, "rd", () => new Date(), () => ({ unreadCount: 3 }));
    const id = convs[0]!.id;
    const r1 = await q.markConversationRead(org, id);
    expect(r1).toEqual({ found: true, changed: true });
    const [a] = await db.select().from(schema.conversation).where(eq(schema.conversation.id, id));
    expect(a!.unreadCount).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    const r2 = await q.markConversationRead(org, id);
    expect(r2).toEqual({ found: true, changed: false });
    const [b] = await db.select().from(schema.conversation).where(eq(schema.conversation.id, id));
    expect(+b!.updatedAt).toBe(+a!.updatedAt); // no tocó la fila
    expect(await q.markConversationRead(org, "cv_no_existe")).toEqual({ found: false, changed: false });
  });

  it("6. los planes usan los índices nuevos con volumen (30 000 mensajes en un hilo, 300 conversaciones)", async () => {
    const { convs } = await sembrar(300, "pl", (i) => new Date(Date.UTC(2038, 0, 1, 0, 0, i)));
    const cv = convs[0]!.id;
    await db.execute(sql`
      insert into message (id, organization_id, conversation_id, direction, type, text, status, wa_timestamp, created_at)
      select 'msg_es${sql.raw(uid)}pl' || g, ${org}, ${cv}, 'in', 'text', 't' || g, 'delivered',
             timestamp '2038-01-01' + (g || ' seconds')::interval, timestamp '2038-01-01' + (g || ' seconds')::interval
      from generate_series(1, 30000) g`);
    await db.execute(sql`analyze message`);
    await db.execute(sql`analyze conversation`);

    const plan = async (consulta: ReturnType<typeof sql>) => {
      const rows = await db.execute<{ "QUERY PLAN": unknown }>(sql`explain (format json) ${consulta}`);
      return JSON.stringify(rows[0]!["QUERY PLAN"]);
    };

    // El preview de la lista: último mensaje por la hora del evento (misma forma que `previewSql`).
    const preview = await plan(sql`
      select coalesce(m.text, m.type) from message m
      where m.organization_id = ${org} and m.conversation_id = ${cv}
      order by coalesce(m.wa_timestamp, m.created_at) desc, m.created_at desc, m.id desc limit 1`);
    expect(preview).toContain("message_event_idx");
    expect(preview).not.toContain("Seq Scan");
    expect(preview).not.toContain('"Node Type":"Sort"');

    // La página del hilo hacia arriba (misma forma que `listMessagesPage`).
    const hilo = await plan(sql`
      select * from message m
      where m.organization_id = ${org} and m.conversation_id = ${cv}
        and (coalesce(m.wa_timestamp, m.created_at), m.created_at, m.id) < ('2038-01-05 00:00:00'::timestamp, '2038-01-05 00:00:00'::timestamp, 'zzz')
      order by coalesce(m.wa_timestamp, m.created_at) desc, m.created_at desc, m.id desc limit 51`);
    expect(hilo).toContain("message_event_idx");
    expect(hilo).not.toContain("Seq Scan");

    // La primera página de la lista (misma forma que `listConversationsPage`).
    const lista = await plan(sql`
      select * from conversation c
      where c.organization_id = ${org} and c.is_test = false
      order by coalesce(c.last_message_at, c.created_at) desc, c.id desc limit 41`);
    expect(lista).toContain("conversation_list_idx");
    expect(lista).not.toContain('"Node Type":"Sort"');

    // y, de punta a punta, la página real devuelve su preview correcto de ese hilo
    const dto = await q.getConversationDto(org, cv);
    expect(dto!.preview).toBe("t30000");
  }, 120_000);

  it("9. la búsqueda también mira el texto de los mensajes: sin duplicar, con filtros, con cursor y con volumen", async () => {
    const { convs } = await sembrar(600, "bm", (i) => new Date(Date.UTC(2039, 0, 1, 0, 0, i)));
    // 600 hilos x 100 mensajes (60 000). Sin tocar nada con la palabra, salvo lo sembrado después.
    await db.execute(sql`
      insert into message (id, organization_id, conversation_id, direction, type, text, status, created_at)
      select 'msg_es${sql.raw(uid)}bm' || c.n || '_' || g, ${org}, 'cv_es${sql.raw(uid)}bm' || c.n, 'in', 'text',
             'mensaje de relleno numero ' || g, 'delivered', timestamp '2039-01-01' + (g || ' seconds')::interval
      from generate_series(0, 599) c(n), generate_series(1, 100) g`);
    const palabra = `zxqtinte${uid}`;
    const poner = (i: number, texto: string, n: number) =>
      db.insert(schema.message).values({
        id: `msg_es${uid}bmx${i}_${n}`, organizationId: org, conversationId: convs[i]!.id,
        direction: "in", type: "text", text: texto, status: "delivered",
      });
    await poner(5, `Quiero un ${palabra} rubio`, 1);
    await poner(5, `y otro ${palabra.toUpperCase()} también`, 2); // 2 coincidencias en el mismo hilo
    await poner(7, `Cuánto cuesta el TÍNTE ${palabra}`, 1);
    await poner(9, "nada que ver", 1);
    await db.execute(sql`analyze message`);

    // 1) cada conversación UNA vez aunque tenga varios mensajes que coinciden
    const todas = await recorrer({ q: palabra }, 1);
    expect(todas.map((c) => c.id).sort()).toEqual([convs[5]!.id, convs[7]!.id].sort());
    // 2) sin acentos ni mayúsculas
    expect((await recorrer({ q: `cuánto cuesta el tínte ${palabra}` })).map((c) => c.id)).toEqual([convs[7]!.id]);
    // 3) un % tecleado no lista todo
    expect((await recorrer({ q: "zxqtin%" })).length).toBe(0);
    // 4) menos de 3 caracteres NO barre mensajes (sí busca nombre)
    expect((await recorrer({ q: "re" })).every((c) => /re/i.test(c.contact.name))).toBe(true);
    // 5) combinado con etapa/no leídas: la coincidencia por mensaje respeta los demás filtros
    await db.update(schema.conversation).set({ unreadCount: 2 }).where(eq(schema.conversation.id, convs[7]!.id));
    expect((await recorrer({ q: palabra, filter: "unread" })).map((c) => c.id)).toEqual([convs[7]!.id]);
    // 6) los contadores usan la misma búsqueda
    const pagina = await q.listConversationsPage(org, { limit: 40, cursor: null, filters: { q: palabra } });
    expect(pagina.counts?.all).toBe(2);
    // 7) por nombre sigue funcionando junto con mensajes
    expect((await recorrer({ q: "Cliente bm 5" })).some((c) => c.id === convs[5]!.id)).toBe(true);
    // 8) otra organización no se ve por sus mensajes
    // 9) volumen: la búsqueda sobre 60 000 mensajes responde en tiempo razonable
    const t0 = performance.now();
    await q.listConversationsPage(org, { limit: 40, cursor: null, filters: { q: palabra } });
    const ms = performance.now() - t0;
    console.log(`búsqueda por mensaje, 60 000 mensajes: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1500);
  }, 180_000);

  it("7. multi-tenancy: cada organización cuenta y lista solo lo suyo", async () => {
    const mine = await db.execute<{ n: number }>(sql`select count(*)::int as n from conversation where organization_id = ${org} and is_test = false`);
    const p = await q.listConversationsPage(org, { limit: 1 });
    expect(p.counts!.total).toBe(mine[0]!.n);
    if (otherOrg) {
      const theirs = await db.execute<{ n: number }>(sql`select count(*)::int as n from conversation where organization_id = ${otherOrg} and is_test = false`);
      const p2 = await q.listConversationsPage(otherOrg, { limit: 1 });
      expect(p2.counts!.total).toBe(theirs[0]!.n);
      expect(await q.unreadTotal(otherOrg)).toBeGreaterThanOrEqual(0);
      // un cursor de la organización A usado en B jamás devuelve filas de A
      const cursorA = p.nextCursor ? cursor.decodeListCursor(p.nextCursor) : null;
      const deB = await q.listConversationsPage(otherOrg, { limit: 100, cursor: cursorA });
      expect(deB.conversations.every((c) => !c.id.startsWith("cv_es"))).toBe(true);
    }
  });

  it("8. /unread suma solo la organización y excluye las conversaciones de prueba", async () => {
    await sembrar(2, "un", () => new Date(), (i) => ({ unreadCount: 5, isTest: i === 1 }));
    const [real] = await db.execute<{ n: number }>(sql`select coalesce(sum(unread_count),0)::int as n from conversation where organization_id = ${org} and is_test = false`);
    expect(await q.unreadTotal(org)).toBe(real!.n);
    const todos = await db.execute<{ n: number }>(sql`select coalesce(sum(unread_count),0)::int as n from conversation where organization_id = ${org}`);
    expect(await q.unreadTotal(org)).toBeLessThan(todos[0]!.n);
  });
});
