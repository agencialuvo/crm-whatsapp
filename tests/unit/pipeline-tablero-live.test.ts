import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 044 — Pipeline: tablero sólido, contra PostgreSQL REAL.
 *
 * Necesita una base con las migraciones aplicadas, así que NO corre con `pnpm test`: se enciende con
 *   RUN_DB_TESTS=1 corepack pnpm exec vitest run tests/unit/pipeline-tablero-live.test.ts
 * Crea sus propias organizaciones (así los papeles de etapa, únicos por negocio, no chocan con los de la
 * instancia) y las borra al terminar; el borrado en cascada se lleva todo lo demás.
 */
const live = process.env.RUN_DB_TESTS === "1";

if (live && !process.env.DATABASE_URL) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!live)("tablero del pipeline contra Postgres", () => {
  let db: ReturnType<(typeof import("@/lib/db"))["getDb"]>;
  let schema: (typeof import("@/lib/db"))["schema"];
  let sql: (typeof import("drizzle-orm"))["sql"];
  let eq: (typeof import("drizzle-orm"))["eq"];
  let inArray: (typeof import("drizzle-orm"))["inArray"];
  let board: typeof import("@/server/leads/board");
  let gate: typeof import("@/server/leads/stage-history");
  let auto: typeof import("@/server/leads/auto-stage");
  let roles: typeof import("@/server/leads/stage-roles");
  let cursorLib: typeof import("@/lib/pipeline-cursor");

  const uid = Date.now().toString(36);
  const orgA = `org_pt${uid}a`;
  const orgB = `org_pt${uid}b`;
  const S = {
    nuevo: `stg_pt${uid}1`,
    conv: `stg_pt${uid}2`,
    inter: `stg_pt${uid}3`,
    cliente: `stg_pt${uid}4`,
    perdido: `stg_pt${uid}5`,
    custom: `stg_pt${uid}6`,
  };
  const B = { nuevo: `stg_pt${uid}b1`, conv: `stg_pt${uid}b2` };

  async function limpiarDeLeads() {
    await db.execute(sql`delete from lead where organization_id in (${orgA}, ${orgB})`);
  }

  /** Siembra `n` leads en una etapa con posiciones dadas (por defecto contiguas). */
  async function sembrar(org: string, stage: string, tag: string, n: number, posOf: (i: number) => number = (i) => i, over = "") {
    await db.execute(sql`
      insert into contact (id, organization_id, name, wa_identity, phone)
      select 'ct_pt${sql.raw(uid)}${sql.raw(tag)}' || g, ${org}, 'Cliente ${sql.raw(tag)} ' || g,
             'pt-${sql.raw(uid)}-${sql.raw(tag)}-' || g, '5255' || lpad((abs(hashtext('${sql.raw(uid + tag)}' || g)) % 100000000)::text, 8, '0')
      from generate_series(1, ${n}) g`);
    await db.execute(sql`
      insert into lead (id, organization_id, contact_id, stage_id, position)
      select 'lead_pt${sql.raw(uid)}${sql.raw(tag)}' || lpad(g::text, 5, '0'), ${org}, 'ct_pt${sql.raw(uid)}${sql.raw(tag)}' || g, ${stage}, (${sql.raw(over || "g - 1")})
      from generate_series(1, ${n}) g`);
    void posOf;
  }

  /** Recorre TODAS las páginas de una columna. */
  async function recorrer(org: string, stage: string, filters: Parameters<typeof board.listColumnPage>[2]["filters"] = {}, limit = 25) {
    const out: Awaited<ReturnType<typeof board.listColumnPage>>["leads"] = [];
    let next: string | null = null;
    let guard = 0;
    do {
      const c: ReturnType<typeof cursorLib.decodeColumnCursor> = next ? cursorLib.decodeColumnCursor(next) : null;
      const page = await board.listColumnPage(org, stage, { limit, cursor: c, filters });
      out.push(...page.leads);
      next = page.nextCursor;
      expect(++guard).toBeLessThan(500);
    } while (next);
    return out;
  }

  async function posiciones(stage: string) {
    const rows = await db.execute<{ id: string; position: number }>(
      sql`select id, position from lead where stage_id = ${stage} order by position, id`
    );
    return [...rows];
  }

  async function eventos(leadIds?: string[]) {
    const rows = await db.execute<{ lead_id: string; to_stage_id: string; from_stage_id: string | null; source: string; auto_rule: string | null }>(
      sql`select lead_id, to_stage_id, from_stage_id, source, auto_rule from lead_stage_event where organization_id in (${orgA}, ${orgB}) order by occurred_at, id`
    );
    return leadIds ? [...rows].filter((r) => leadIds.includes(r.lead_id)) : [...rows];
  }

  beforeAll(async () => {
    ({ sql, eq, inArray } = await import("drizzle-orm"));
    const l = await import("@/lib/db");
    db = l.getDb();
    schema = l.schema;
    board = await import("@/server/leads/board");
    gate = await import("@/server/leads/stage-history");
    auto = await import("@/server/leads/auto-stage");
    roles = await import("@/server/leads/stage-roles");
    cursorLib = await import("@/lib/pipeline-cursor");

    await db.insert(schema.organization).values([
      { id: orgA, name: `Pipeline A ${uid}` },
      { id: orgB, name: `Pipeline B ${uid}` },
    ]);
    await db.insert(schema.pipelineStage).values([
      { id: S.nuevo, organizationId: orgA, name: "Nuevo", position: 0, kind: "open", autoRole: "new" },
      { id: S.conv, organizationId: orgA, name: "En conversación", position: 1, kind: "open", autoRole: "conversation" },
      { id: S.inter, organizationId: orgA, name: "Interesado", position: 2, kind: "open", autoRole: "interested" },
      { id: S.cliente, organizationId: orgA, name: "Cliente", position: 3, kind: "won", autoRole: "client" },
      { id: S.perdido, organizationId: orgA, name: "No interesado", position: 4, kind: "lost" },
      { id: S.custom, organizationId: orgA, name: "Negociación", position: 5, kind: "open" },
      { id: B.nuevo, organizationId: orgB, name: "Nuevo", position: 0, kind: "open", autoRole: "new" },
      { id: B.conv, organizationId: orgB, name: "En conversación", position: 1, kind: "open", autoRole: "conversation" },
    ]);
  });

  // Un fallo a medias no contamina la prueba siguiente.
  beforeEach(async () => {
    if (db) await limpiarDeLeads();
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.organization).where(inArray(schema.organization.id, [orgA, orgB]));
  }, 120_000);

  it("1. paginación por columna sin huecos ni repetidos, con posiciones EMPATADAS y negativas", async () => {
    // 600 leads; posiciones con empates (g/3) y algunas negativas (entradas «arriba» sin renumerar).
    await sembrar(orgA, S.nuevo, "pg", 600, (i) => i, "(g / 3) - 20");
    const todas = await recorrer(orgA, S.nuevo, {}, 25);
    expect(todas).toHaveLength(600);
    expect(new Set(todas.map((l) => l.id)).size).toBe(600);
    // orden de pantalla: (posición, id)
    const orden = [...todas].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
    expect(todas.map((l) => l.id)).toEqual(orden.map((l) => l.id));
    // un tamaño de página distinto da lo mismo
    expect((await recorrer(orgA, S.nuevo, {}, 50)).map((l) => l.id)).toEqual(todas.map((l) => l.id));
    await limpiarDeLeads();
  }, 120_000);

  it("2. renumeración: 30 movimientos SIMULTÁNEOS a una columna la dejan contigua 0..n-1, sin duplicados, con un evento por cambio", async () => {
    await sembrar(orgA, S.nuevo, "rn", 40);
    await sembrar(orgA, S.conv, "rc", 10);
    const ids = Array.from({ length: 30 }, (_, i) => `lead_pt${uid}rn${String(i + 1).padStart(5, "0")}`);
    const resultados = await Promise.all(
      ids.map((id, i) =>
        gate.moveLeadToStage({
          organizationId: orgA,
          leadId: id,
          toStageId: S.conv,
          position: (i * 7) % 12,
          source: "dueno",
        })
      )
    );
    expect(resultados.every((r) => r.ok)).toBe(true);
    for (const stage of [S.nuevo, S.conv]) {
      const rows = await posiciones(stage);
      expect(rows.map((r) => Number(r.position))).toEqual(rows.map((_, i) => i));
    }
    expect((await posiciones(S.conv)).length).toBe(40);
    expect((await posiciones(S.nuevo)).length).toBe(10);
    // un evento de bitácora por movimiento entre etapas
    const ev = await eventos(ids);
    expect(ev.filter((e) => e.to_stage_id === S.conv).length).toBe(30);
    await limpiarDeLeads();
  }, 120_000);

  it("3. mover dentro de la misma columna reescribe solo el tramo afectado", async () => {
    await sembrar(orgA, S.nuevo, "tr", 100);
    const antes = await db.execute<{ id: string; xmin: string }>(sql`select id, xmin::text from lead where stage_id = ${S.nuevo}`);
    const prev = new Map([...antes].map((r) => [r.id, r.xmin]));
    // del índice 90 al 95: solo cambian las posiciones 90..95
    const res = await gate.moveLeadToStage({
      organizationId: orgA,
      leadId: `lead_pt${uid}tr${String(91).padStart(5, "0")}`,
      toStageId: S.nuevo,
      position: 95,
      source: "dueno",
    });
    expect(res.ok && res.changed).toBe(false); // misma etapa: no hay evento
    const despues = await db.execute<{ id: string; xmin: string; position: number }>(
      sql`select id, xmin::text, position from lead where stage_id = ${S.nuevo} order by position, id`
    );
    const cambiadas = [...despues].filter((r) => prev.get(r.id) !== r.xmin);
    expect(cambiadas.length).toBeLessThanOrEqual(6);
    expect(cambiadas.length).toBeGreaterThan(0);
    expect([...despues].map((r) => Number(r.position))).toEqual([...despues].map((_, i) => i));
    expect([...despues][95]!.id).toBe(`lead_pt${uid}tr${String(91).padStart(5, "0")}`);
    expect(await eventos()).toHaveLength(0);
    await limpiarDeLeads();
  }, 60_000);

  it("4. un lead que cambia de etapa sin pedir posición entra ARRIBA de la columna destino", async () => {
    await sembrar(orgA, S.conv, "ar", 5);
    await sembrar(orgA, S.nuevo, "ar2", 1);
    const id = `lead_pt${uid}ar2${String(1).padStart(5, "0")}`;
    const r = await gate.moveLeadToStage({ organizationId: orgA, leadId: id, toStageId: S.conv, source: "dueno" });
    expect(r.ok && r.changed).toBe(true);
    const col = await recorrer(orgA, S.conv);
    expect(col[0]!.id).toBe(id);
    expect(col).toHaveLength(6);
    await limpiarDeLeads();
  }, 60_000);

  it("5. dos movimientos simultáneos del MISMO lead: el candado serializa y un solo evento por cambio real", async () => {
    await sembrar(orgA, S.nuevo, "cd", 1);
    const id = `lead_pt${uid}cd${String(1).padStart(5, "0")}`;
    const [x, y] = await Promise.all([
      gate.moveLeadToStage({ organizationId: orgA, leadId: id, toStageId: S.conv, source: "dueno" }),
      gate.moveLeadToStage({ organizationId: orgA, leadId: id, toStageId: S.conv, source: "bot" }),
    ]);
    expect(x.ok && y.ok).toBe(true);
    // exactamente uno de los dos vio el cambio; el segundo ya lo encontró en la etapa destino
    expect([x.ok && x.changed, y.ok && y.changed].filter(Boolean)).toHaveLength(1);
    const ev = await eventos([id]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.from_stage_id).toBe(S.nuevo);
    await limpiarDeLeads();
  }, 60_000);

  it("6. filtros: nombre, teléfono, texto de un mensaje, prioridad, etiqueta y canal; conteos y sumas iguales a la lista", async () => {
    await sembrar(orgA, S.nuevo, "fl", 60);
    await db.execute(sql`update lead set priority = 'alta', amount_cents = 1000, currency = 'PEN' where id like ${`lead_pt${uid}fl%0000%`}`);
    await db.execute(sql`update lead set priority = 'baja', amount_cents = 250, currency = 'USD' where id = ${`lead_pt${uid}fl00060`}`);
    await db.execute(sql`update contact set channel = 'instagram', wa_identity = 'ig-' || id where id = ${`ct_pt${uid}fl7`}`);
    // un mensaje con una palabra única en la conversación de un lead
    const palabra = `zxqpipe${uid.replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]!)}`;
    await db.execute(sql`insert into conversation (id, organization_id, contact_id) values (${`cv_pt${uid}fl3`}, ${orgA}, ${`ct_pt${uid}fl3`})`);
    await db.execute(sql`insert into message (id, organization_id, conversation_id, direction, type, text, status)
      values (${`msg_pt${uid}fl3`}, ${orgA}, ${`cv_pt${uid}fl3`}, 'in', 'text', ${`Quiero un ${palabra} rubio`}, 'delivered')`);
    // una etiqueta
    await db.execute(sql`insert into tag (id, organization_id, name, color) values (${`tag_pt${uid}`}, ${orgA}, ${`VIP ${uid}`}, 'slate')`);
    await db.execute(sql`insert into contact_tag (organization_id, contact_id, tag_id) values (${orgA}, ${`ct_pt${uid}fl9`}, ${`tag_pt${uid}`})`);

    const q = async (f: Parameters<typeof board.listColumnPage>[2]["filters"]) => ({
      lista: await recorrer(orgA, S.nuevo, f, 25),
      totales: (await board.stageTotals(orgA, "PEN", f)).get(S.nuevo),
    });

    // texto en un mensaje (sin acentos ni mayúsculas)
    const porMensaje = await q({ q: palabra.toUpperCase() });
    expect(porMensaje.lista.map((l) => l.contact.id)).toEqual([`ct_pt${uid}fl3`]);
    expect(porMensaje.totales?.count).toBe(1);
    // nombre
    expect((await q({ q: "Cliente fl 12" })).lista.some((l) => l.contact.id === `ct_pt${uid}fl12`)).toBe(true);
    // prioridad
    const alta = await q({ priority: "alta" });
    expect(alta.lista.length).toBe(alta.totales?.count);
    expect(alta.lista.every((l) => l.priority === "alta")).toBe(true);
    const sin = await q({ priority: "sin" });
    expect(sin.lista.every((l) => l.priority === null)).toBe(true);
    expect(sin.totales?.count).toBe(sin.lista.length);
    // etiqueta y canal
    expect((await q({ tag: `tag_pt${uid}` })).lista.map((l) => l.contact.id)).toEqual([`ct_pt${uid}fl9`]);
    expect((await q({ channel: "instagram" })).lista.map((l) => l.contact.id)).toEqual([`ct_pt${uid}fl7`]);
    // sumas: solo lo sumable (la moneda del negocio); lo demás se cuenta aparte
    const todo = await board.stageTotals(orgA, "PEN", {});
    const t = todo.get(S.nuevo)!;
    expect(t.count).toBe(60);
    expect(t.otherCurrency).toBe(1);
    expect(t.sumCents).toBe(Number(t.count - t.withoutAmount - t.otherCurrency) * 1000);
    // el servidor y la lista dicen lo mismo con cualquier filtro
    for (const f of [{ priority: "alta" as const }, { q: "Cliente fl 1" }]) {
      const r = await q(f);
      expect(r.totales?.count ?? 0).toBe(r.lista.length);
    }
    await db.execute(sql`delete from tag where id = ${`tag_pt${uid}`}`);
    await limpiarDeLeads();
  }, 120_000);

  it("7. delta con since: detecta movimiento, monto y alta; marca matches; no devuelve lo que no cambió", async () => {
    await sembrar(orgA, S.nuevo, "dl", 5);
    await new Promise((r) => setTimeout(r, 2200)); // más que el solape de 2 s del delta
    const desde = new Date();
    const id = (n: number) => `lead_pt${uid}dl${String(n).padStart(5, "0")}`;
    await gate.moveLeadToStage({ organizationId: orgA, leadId: id(1), toStageId: S.conv, source: "dueno" });
    await db.execute(sql`update lead set amount_cents = 777, updated_at = now() where id = ${id(2)}`);
    const d = await board.boardDelta(orgA, "PEN", desde, {});
    expect(d.changed.map((c) => c.id).sort()).toEqual([id(1), id(2)]);
    expect(d.changed.find((c) => c.id === id(1))!.stageId).toBe(S.conv);
    expect(d.truncated).toBe(false);
    expect(d.totals[S.conv]!.count).toBeGreaterThanOrEqual(1);
    // con un filtro que el lead movido ya no cumple, `matches` es false
    const f = await board.boardDelta(orgA, "PEN", desde, { priority: "alta" });
    expect(f.changed.every((c) => c.matches === false)).toBe(true);
    await limpiarDeLeads();
  }, 60_000);

  it("7b. un delta de más de 200 tarjetas se marca truncated", async () => {
    await sembrar(orgA, S.nuevo, "tk", 230);
    const d = await board.boardDelta(orgA, "PEN", new Date(Date.now() - 60_000), {});
    expect(d.truncated).toBe(true);
    expect(d.changed.length).toBe(board.BOARD_DELTA_MAX);
    await limpiarDeLeads();
  }, 60_000);

  describe("reglas automáticas de punta a punta (funciones reales)", () => {
    let n = 0;
    /** Un lead con conversación real (o de prueba) en la etapa dada. */
    async function conLead(stage: string, opts: { isTest?: boolean; amount?: number | null } = {}) {
      const k = `${++n}`;
      const contactId = `ct_ptr${uid}${k}`;
      await db.execute(sql`insert into contact (id, organization_id, name, wa_identity, phone)
        values (${contactId}, ${orgA}, ${`Auto ${k}`}, ${`ptr-${uid}-${k}`}, ${`5255${String(1000000 + Number(k))}`})`);
      const conversationId = `cv_ptr${uid}${k}`;
      await db.execute(sql`insert into conversation (id, organization_id, contact_id, is_test)
        values (${conversationId}, ${orgA}, ${contactId}, ${opts.isTest ?? false})`);
      const leadId = `lead_ptr${uid}${k}`;
      await db.execute(sql`insert into lead (id, organization_id, contact_id, stage_id, position, amount_cents)
        values (${leadId}, ${orgA}, ${contactId}, ${stage}, 0, ${opts.amount ?? null})`);
      return { contactId, conversationId, leadId };
    }
    const etapaDe = async (leadId: string) =>
      (await db.select({ s: schema.lead.stageId, a: schema.lead.amountCents, c: schema.lead.currency }).from(schema.lead).where(eq(schema.lead.id, leadId)))[0]!;

    it("primer envío: «Nuevo» → «En conversación» con evento sistema/first_reply; el segundo no hace nada", async () => {
      const x = await conLead(S.nuevo);
      await auto.avanzarPorRespuesta(orgA, x.conversationId);
      expect((await etapaDe(x.leadId)).s).toBe(S.conv);
      await auto.avanzarPorRespuesta(orgA, x.conversationId);
      await auto.avanzarPorRespuesta(orgA, x.conversationId);
      const ev = (await eventos([x.leadId])).filter((e) => e.auto_rule);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ source: "sistema", auto_rule: "first_reply", from_stage_id: S.nuevo, to_stage_id: S.conv });
    });

    it("el Laboratorio (is_test) nunca mueve un lead", async () => {
      const x = await conLead(S.nuevo, { isTest: true });
      await auto.avanzarPorRespuesta(orgA, x.conversationId);
      expect((await etapaDe(x.leadId)).s).toBe(S.nuevo);
    });

    it("cita: desde «Nuevo» y desde «En conversación» → «Interesado»; desde «Interesado» o una etapa sin papel, no", async () => {
      const a = await conLead(S.nuevo);
      const b = await conLead(S.conv);
      const c = await conLead(S.inter);
      const d = await conLead(S.custom);
      for (const x of [a, b, c, d]) await auto.advanceLeadForContact({ organizationId: orgA, contactId: x.contactId, rule: "booking" });
      expect((await etapaDe(a.leadId)).s).toBe(S.inter);
      expect((await etapaDe(b.leadId)).s).toBe(S.inter);
      expect((await etapaDe(c.leadId)).s).toBe(S.inter);
      expect((await etapaDe(d.leadId)).s).toBe(S.custom);
      expect((await eventos([a.leadId, b.leadId])).every((e) => e.auto_rule === "booking")).toBe(true);
    });

    it("venta: salto directo desde «Nuevo» a «Cliente»; también desde una etapa sin papel; y toma el monto de la venta si no tenía", async () => {
      const a = await conLead(S.nuevo);
      const b = await conLead(S.custom, { amount: 5000 });
      await auto.advanceLeadForContact({ organizationId: orgA, contactId: a.contactId, rule: "sale", amountCents: 12000 });
      await auto.advanceLeadForContact({ organizationId: orgA, contactId: b.contactId, rule: "sale", amountCents: 12000 });
      expect((await etapaDe(a.leadId)).s).toBe(S.cliente);
      expect((await etapaDe(a.leadId)).a).toBe(12000); // sin monto previo: toma el de la venta
      expect((await etapaDe(b.leadId)).s).toBe(S.cliente);
      expect((await etapaDe(b.leadId)).a).toBe(5000); // ya tenía monto: no se pisa
    });

    it("un lead ganado o perdido no se reabre solo, con ninguna regla", async () => {
      const g = await conLead(S.cliente);
      const p = await conLead(S.perdido);
      for (const rule of ["first_reply", "booking", "sale"] as const) {
        await auto.advanceLeadForContact({ organizationId: orgA, contactId: g.contactId, rule });
        await auto.advanceLeadForContact({ organizationId: orgA, contactId: p.contactId, rule });
      }
      expect((await etapaDe(g.leadId)).s).toBe(S.cliente);
      expect((await etapaDe(p.leadId)).s).toBe(S.perdido);
    });

    it("sin lead no se crea uno; sin la etapa destino (papel sin asignar) no pasa nada y no falla", async () => {
      await db.execute(sql`insert into contact (id, organization_id, name, wa_identity, phone)
        values (${`ct_ptsl${uid}`}, ${orgA}, 'Mostrador', ${`ptsl-${uid}`}, '5255999')`);
      const r = await auto.advanceLeadForContact({ organizationId: orgA, contactId: `ct_ptsl${uid}`, rule: "sale", amountCents: 100 });
      expect(r.moved).toBe(false);
      const n0 = await db.execute(sql`select count(*)::int as n from lead where contact_id = ${`ct_ptsl${uid}`}`);
      expect([...n0][0]!.n).toBe(0);
      // organización B no tiene «Interesado» ni «Cliente»
      await db.execute(sql`insert into contact (id, organization_id, name, wa_identity, phone) values (${`ct_ptb${uid}`}, ${orgB}, 'B', ${`ptb-${uid}`}, '5255888')`);
      await db.execute(sql`insert into lead (id, organization_id, contact_id, stage_id, position) values (${`lead_ptb${uid}`}, ${orgB}, ${`ct_ptb${uid}`}, ${B.nuevo}, 0)`);
      const rb = await auto.advanceLeadForContact({ organizationId: orgB, contactId: `ct_ptb${uid}`, rule: "booking" });
      expect(rb.moved).toBe(false);
      const sb = await etapaDe(`lead_ptb${uid}`);
      expect(sb.s).toBe(B.nuevo);
    });

    it("carrera: el primer envío de la IA y el del operador a la vez mueven el lead UNA vez", async () => {
      const x = await conLead(S.nuevo);
      await Promise.all(Array.from({ length: 8 }, () => auto.avanzarPorRespuesta(orgA, x.conversationId)));
      const ev = (await eventos([x.leadId])).filter((e) => e.auto_rule === "first_reply");
      expect(ev).toHaveLength(1);
      expect((await etapaDe(x.leadId)).s).toBe(S.conv);
    });

    it("un movimiento automático entra ARRIBA de la columna destino", async () => {
      const dest = await conLead(S.conv);
      const x = await conLead(S.nuevo);
      await auto.avanzarPorRespuesta(orgA, x.conversationId);
      const col = await recorrer(orgA, S.conv, {}, 50);
      const iX = col.findIndex((l) => l.id === x.leadId);
      const iD = col.findIndex((l) => l.id === dest.leadId);
      expect(iX).toBeLessThan(iD);
    });
  });

  it("8. papeles de etapa: uno por negocio (índice único) y válidos para el tipo de etapa", async () => {
    await expect(
      db.update(schema.pipelineStage).set({ autoRole: "new" }).where(eq(schema.pipelineStage.id, S.custom))
    ).rejects.toThrow();
    expect(await roles.checkStageRole(orgA, { id: S.custom, kind: "open" }, "new")).toMatchObject({ status: 409, code: "role_taken" });
    expect(await roles.checkStageRole(orgA, { id: S.nuevo, kind: "open" }, "new")).toBeNull(); // el mismo que ya lo tiene
    expect(await roles.checkStageRole(orgA, { id: S.perdido, kind: "lost" }, "new")).toMatchObject({ code: "invalid_role" });
    expect(await roles.checkStageRole(orgA, { id: S.cliente, kind: "won" }, "new")).toMatchObject({ code: "invalid_role" });
    expect(await roles.checkStageRole(orgA, { id: S.custom, kind: "open" }, "client")).toMatchObject({ code: "invalid_role" });
    expect(await roles.checkStageRole(orgA, { id: S.custom, kind: "open" }, null)).toBeNull();
    // la organización B puede tener su propio «Nuevo»: el índice es por negocio
    expect(await roles.checkStageRole(orgB, { id: B.conv, kind: "open" }, "interested")).toBeNull();
  });

  it("9. multi-tenencia: un tablero, un cursor o una regla de una organización jamás toca a otra", async () => {
    await sembrar(orgA, S.nuevo, "ta", 30);
    await sembrar(orgB, B.nuevo, "tb", 7);
    const a = await board.boardSnapshot(orgA, "PEN", { limit: 25 });
    const b = await board.boardSnapshot(orgB, "PEN", { limit: 25 });
    expect(a.find((s) => s.id === S.nuevo)!.totals.count).toBe(30);
    expect(b.find((s) => s.id === B.nuevo)!.totals.count).toBe(7);
    expect(b.flatMap((s) => s.leads).every((l) => l.id.includes("tb"))).toBe(true);
    // el cursor de A sobre una columna de B no devuelve nada de A
    const p = await board.listColumnPage(orgA, S.nuevo, { limit: 5 });
    const leak = await board.listColumnPage(orgB, S.nuevo, { limit: 5, cursor: cursorLib.decodeColumnCursor(p.nextCursor!) });
    expect(leak.leads).toHaveLength(0);
    // mover un lead de B a una etapa de A: la etapa no existe para B
    const r = await gate.moveLeadToStage({ organizationId: orgB, leadId: `lead_pt${uid}tb00001`, toStageId: S.conv, source: "dueno" });
    expect(r.ok).toBe(false);
    await limpiarDeLeads();
  }, 60_000);

  it("10. los planes con 5 000 leads: la página de columna usa lead_board_idx sin Sort; el delta usa lead_org_updated_idx", async () => {
    await sembrar(orgA, S.nuevo, "pl", 5000);
    await db.execute(sql`analyze lead`);
    const plan = async (consulta: ReturnType<typeof sql>) => {
      const rows = await db.execute<{ "QUERY PLAN": unknown }>(sql`explain (format json) ${consulta}`);
      return JSON.stringify(rows[0]!["QUERY PLAN"]);
    };
    const pagina = await plan(sql`
      select * from lead l
      where l.organization_id = ${orgA} and l.stage_id = ${S.nuevo}
        and (l.position > 100 or (l.position = 100 and l.id > 'lead_x'))
      order by l.position, l.id limit 26`);
    expect(pagina).toContain("lead_board_idx");
    expect(pagina).not.toContain('"Node Type":"Sort"');
    const delta = await plan(sql`
      select * from lead l where l.organization_id = ${orgA} and l.updated_at > now() - interval '1 second'
      order by l.updated_at, l.id limit 201`);
    expect(delta).toContain("lead_org_updated_idx");
    // de punta a punta: la página real responde rápido con 5 000 leads
    const t0 = performance.now();
    await board.listColumnPage(orgA, S.nuevo, { limit: 25 });
    expect(performance.now() - t0).toBeLessThan(500);
    await limpiarDeLeads();
  }, 120_000);

  it("11. la migración 0079 dejó las columnas, los índices y el índice único parcial", async () => {
    const idx = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where tablename in ('lead', 'pipeline_stage') and indexname in ('lead_board_idx', 'lead_org_updated_idx', 'stage_org_auto_role_uq')`
    );
    expect([...idx].map((r) => r.indexname).sort()).toEqual(["lead_board_idx", "lead_org_updated_idx", "stage_org_auto_role_uq"]);
    const cols = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where (table_name = 'pipeline_stage' and column_name = 'auto_role') or (table_name = 'lead_stage_event' and column_name = 'auto_rule')`
    );
    expect([...cols]).toHaveLength(2);
    const viejo = await db.execute(sql`select 1 from pg_indexes where indexname = 'lead_org_stage_idx'`);
    expect([...viejo]).toHaveLength(0);
  });
});
