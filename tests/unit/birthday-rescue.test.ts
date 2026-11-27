import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { birthdayDedupeKey } from "@/lib/automation";
import {
  birthdayRescueDedupeKey,
  birthdayRowState,
  buildBirthdayCampaign,
  computeRescueSummary,
  daysLeftInMonth,
  filterBirthdays,
  rescueBlock,
  rescuePeriodOf,
  rescueStateOf,
  type RescueBlock,
} from "@/lib/salon/birthday-campaign";
import type { SalonDashboardDto } from "@/lib/salon/types";

/**
 * Cumpleaños — Paso 3: rescate de fin de mes («Última oportunidad»). Audiencia no convertida, exclusiones
 * (cita, compra, baja, sin chat real, ya rescatado), deduplicación del mes, lanzamiento y permisos.
 */

describe("reglas del rescate", () => {
  it("periodo, llave propia (separada del saludo) y días que quedan", () => {
    expect(rescuePeriodOf("2026-11-27")).toBe("2026-11");
    expect(birthdayRescueDedupeKey("2026-11")).toBe("birthday_rescue:2026-11");
    expect(birthdayRescueDedupeKey("2026-11")).not.toBe(birthdayDedupeKey(2026));
    expect(daysLeftInMonth("2026-11-27")).toBe(3);
    expect(daysLeftInMonth("2026-11-30")).toBe(0);
    expect(daysLeftInMonth("2028-02-01")).toBe(28); // bisiesto
  });

  it("rescueStateOf: entrega > fallo > en cola > nada", () => {
    expect(rescueStateOf({ claimed: false, outcomes: [], runStatuses: [] })).toBeNull();
    expect(rescueStateOf({ claimed: true, outcomes: [], runStatuses: [] })).toBe("pending");
    expect(rescueStateOf({ claimed: true, outcomes: [], runStatuses: ["waiting"] })).toBe("pending");
    expect(rescueStateOf({ claimed: true, outcomes: [], runStatuses: ["cancelled"] })).toBe("failed");
    expect(rescueStateOf({ claimed: true, outcomes: ["failed"], runStatuses: ["failed"] })).toBe("failed");
    expect(rescueStateOf({ claimed: true, outcomes: ["failed", "delivered"], runStatuses: ["completed"] })).toBe("delivered");
  });

  it("rescueBlock: solo entra quien no reservó ni aprovechó, no fue rescatado, no se dio de baja y tiene chat real", () => {
    const base = { converted: false, booked: false, rescue: null, optedOut: false, reachable: true } as const;
    expect(rescueBlock(base)).toBeNull();
    expect(rescueBlock({ ...base, converted: true, booked: true })).toBe("converted");
    expect(rescueBlock({ ...base, booked: true })).toBe("booked");
    // Un rescate fallido NO se reenvía en el mes.
    expect(rescueBlock({ ...base, rescue: "failed" })).toBe("already_rescued");
    expect(rescueBlock({ ...base, optedOut: true })).toBe("opted_out");
    expect(rescueBlock({ ...base, reachable: false })).toBe("no_conversation");
  });

  it("un rescate entregado cuenta como contacto; uno fallido deja la fila en «fallido»", () => {
    const f = { sends: [], manual: false, booked: false, attended: false, sales: 0, salesCents: 0 };
    expect(birthdayRowState({ ...f, rescue: "delivered" })).toMatchObject({ status: "enviado", contactedBy: "auto", rescue: "delivered" });
    expect(birthdayRowState({ ...f, rescue: "failed" })).toMatchObject({ status: "fallido", sendFailed: true });
    expect(birthdayRowState({ ...f, rescue: "pending" })).toMatchObject({ status: "sin_enviar", rescue: "pending" });
  });
});

describe("buildBirthdayCampaign con el rescate", () => {
  const c = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: id,
    phone: "51999000111",
    day: 5,
    visits: 0,
    totalCents: 0,
    optedOut: false,
    reachable: true,
    ...over,
  });
  const built = buildBirthdayCampaign({
    contacts: [
      c("sinenviar"),
      c("saludado"),
      c("agendado"),
      c("aprovecho"),
      c("baja", { optedOut: true }),
      c("soloLab", { reachable: false }),
      c("rescatado"),
      c("rescateFallido"),
    ],
    flows: [{ id: "aut_s", name: "Saludo", active: true }],
    sends: [{ contactId: "saludado", flowId: "aut_s", logStatus: "success", messageStatus: "read" }],
    manual: new Set(),
    bookings: [{ contactId: "agendado", status: "agendada" }],
    sales: [{ contactId: "aprovecho", count: 1, cents: 5000 }],
    rescue: {
      claimed: new Set(["rescatado", "rescateFallido"]),
      runs: [
        { contactId: "rescatado", status: "completed" },
        { contactId: "rescateFallido", status: "failed" },
      ],
      sends: [
        { contactId: "rescatado", logStatus: "success", messageStatus: "delivered" },
        { contactId: "rescateFallido", logStatus: "failed", messageStatus: null },
      ],
    },
  });
  const block = Object.fromEntries(built.clients.map((x) => [x.id, x.rescueBlock]));

  it("audiencia no convertida: «sin enviar» y «saludado sin cita»; fuera el resto con su motivo", () => {
    expect(block).toEqual({
      sinenviar: null,
      saludado: null,
      agendado: "booked",
      aprovecho: "converted",
      baja: "opted_out",
      soloLab: "no_conversation",
      rescatado: "already_rescued",
      rescateFallido: "already_rescued",
    });
  });

  it("resumen del rescate y el filtro «Para rescatar»", () => {
    const s = computeRescueSummary(built.clients, "2026-11-27");
    expect(s).toMatchObject({
      period: "2026-11",
      daysLeft: 3,
      suggested: true,
      eligible: 2,
      excluded: { opted_out: 1, no_conversation: 1 },
      launched: 2,
      delivered: 1,
      failed: 1,
      pending: 0,
      conversionRate: 0,
    });
    expect(computeRescueSummary(built.clients, "2026-11-10").suggested).toBe(false);
    expect(filterBirthdays(built.clients, { filter: "rescatar", query: "" }).map((x) => x.id)).toEqual(["sinenviar", "saludado"]);
  });
});

// ---------------------------------------------------------------- lanzamiento
describe("launchBirthdayRescue", () => {
  let mod: typeof import("@/server/business/birthday-rescue");
  beforeAll(async () => {
    mod = await import("@/server/business/birthday-rescue");
  }, 60_000);

  function deps(over: Partial<import("@/server/business/birthday-rescue").RescueDeps> = {}) {
    const claimed = new Set<string>();
    const enqueued: string[] = [];
    const released: string[] = [];
    const audience: { id: string; day: number; rescueBlock: RescueBlock | null }[] = [
      { id: "ct_a", day: 6, rescueBlock: null },
      { id: "ct_b", day: 29, rescueBlock: null },
      { id: "ct_cita", day: 10, rescueBlock: "booked" },
      { id: "ct_baja", day: 12, rescueBlock: "opted_out" },
    ];
    const d: import("@/server/business/birthday-rescue").RescueDeps = {
      loadFlow: async () => ({ id: "aut_m", triggerType: "manual", active: true }),
      flowGreets: async () => false,
      audience: async () => ({ today: "2026-11-27", windowDays: 7, benefit: "20% de descuento", clients: audience }),
      claim: async ({ contactId, period }) => {
        const k = `${contactId}|${period}`;
        if (claimed.has(k)) return false;
        claimed.add(k);
        return true;
      },
      release: async ({ contactId, period }) => {
        claimed.delete(`${contactId}|${period}`);
        released.push(contactId);
      },
      enqueue: async ({ contactId }) => {
        enqueued.push(contactId);
        return true;
      },
      now: () => new Date("2026-11-27T15:00:00Z"),
      ...over,
    };
    return { d, claimed, enqueued, released };
  }

  it("encola solo a los elegibles, con el periodo del negocio", async () => {
    const { d, enqueued, claimed } = deps();
    const r = await mod.launchBirthdayRescue({ organizationId: "org_1", flowId: "aut_m", triggeredBy: "usr_1" }, d);
    expect(r).toEqual({ period: "2026-11", flowId: "aut_m", attempted: 2, enqueued: 2, skipped: [], remaining: 0 });
    expect(enqueued).toEqual(["ct_a", "ct_b"]);
    expect([...claimed]).toEqual(["ct_a|2026-11", "ct_b|2026-11"]);
  });

  it("relanzar (o lanzar con otro flujo) no reenvía: el control del mes ya está reclamado", async () => {
    const { d, enqueued } = deps();
    await mod.launchBirthdayRescue({ organizationId: "org_1", flowId: "aut_m", triggeredBy: "usr_1" }, d);
    const again = await mod.launchBirthdayRescue({ organizationId: "org_1", flowId: "aut_otro", triggeredBy: "usr_1" }, d);
    expect(again.enqueued).toBe(0);
    expect(again.skipped).toEqual([
      { contactId: "ct_a", reason: "already_rescued" },
      { contactId: "ct_b", reason: "already_rescued" },
    ]);
    expect(enqueued).toEqual(["ct_a", "ct_b"]);
  });

  it("si el motor ya tenía esa ejecución, el control se queda (no se reenvía)", async () => {
    const { d, released } = deps({ enqueue: async () => false });
    const r = await mod.launchBirthdayRescue({ organizationId: "org_1", flowId: "aut_m", triggeredBy: "usr_1" }, d);
    expect(r.enqueued).toBe(0);
    expect(r.skipped.every((s) => s.reason === "already_rescued")).toBe(true);
    expect(released).toEqual([]);
  });

  it("un fallo al encolar suelta el control, no cuenta como enviado y no frena a los demás", async () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    const { d, claimed, released } = deps({
      enqueue: async ({ contactId }) => {
        if (contactId === "ct_a") throw new Error("base caída");
        return true;
      },
    });
    const r = await mod.launchBirthdayRescue({ organizationId: "org_1", flowId: "aut_m", triggeredBy: "usr_1" }, d);
    expect(r.enqueued).toBe(1);
    expect(r.skipped).toEqual([{ contactId: "ct_a", reason: "error" }]);
    expect(released).toEqual(["ct_a"]);
    expect(claimed.has("ct_a|2026-11")).toBe(false);
    consola.mockRestore();
  });

  it("si reclamar el control falla, ese cliente se omite (sin encolar) y los demás siguen", async () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    const { d, enqueued } = deps();
    const claim = d.claim;
    d.claim = async (input) => {
      if (input.contactId === "ct_a") throw new Error("clave foránea");
      return claim(input);
    };
    const r = await mod.launchBirthdayRescue({ organizationId: "org_1", flowId: "aut_m", triggeredBy: "usr_1" }, d);
    expect(enqueued).toEqual(["ct_b"]);
    expect(r).toMatchObject({ enqueued: 1, skipped: [{ contactId: "ct_a", reason: "error" }] });
    consola.mockRestore();
  });

  it("`contactIds` acota y nunca agrega: los no elegibles o ajenos salen con su motivo", async () => {
    const { d, enqueued } = deps();
    const r = await mod.launchBirthdayRescue(
      { organizationId: "org_1", flowId: "aut_m", contactIds: ["ct_b", "ct_cita", "ct_baja", "ct_ajeno", "ct_b"], triggeredBy: "usr_1" },
      d
    );
    expect(enqueued).toEqual(["ct_b"]);
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        { contactId: "ct_ajeno", reason: "not_birthday" },
        { contactId: "ct_cita", reason: "booked" },
        { contactId: "ct_baja", reason: "opted_out" },
      ])
    );
  });

  it("tope por lanzamiento: lo que no entra queda como pendiente", async () => {
    const many = Array.from({ length: mod.RESCUE_MAX_PER_LAUNCH + 5 }, (_, i) => ({ id: `ct_${i}`, day: 5, rescueBlock: null }));
    const { d } = deps({ audience: async () => ({ today: "2026-11-27", windowDays: 7, benefit: "x", clients: many }) });
    const r = await mod.launchBirthdayRescue({ organizationId: "org_1", flowId: "aut_m", triggeredBy: "usr_1" }, d);
    expect(r.attempted).toBe(mod.RESCUE_MAX_PER_LAUNCH);
    expect(r.remaining).toBe(5);
  });

  it("el flujo debe existir, ser manual y estar encendido (sin tocar la audiencia)", async () => {
    const audience = vi.fn();
    const cases: [import("@/server/business/birthday-rescue").RescueFlow | null, string][] = [
      [null, "not_found"],
      [{ id: "aut_b", triggerType: "birthday", active: true }, "not_manual_flow"],
      [{ id: "aut_m", triggerType: "manual", active: false }, "flow_inactive"],
    ];
    for (const [flow, code] of cases) {
      const { d } = deps({ loadFlow: async () => flow, audience });
      await expect(mod.launchBirthdayRescue({ organizationId: "org_1", flowId: "x", triggeredBy: "usr_1" }, d)).rejects.toMatchObject({ code });
    }
    expect(audience).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- tarjeta
describe("tarjeta: bloque del rescate", () => {
  async function render(rescue: SalonDashboardDto["birthdays"]["rescue"]) {
    const { BirthdaysSection } = await import("@/components/negocio/dashboard-birthdays");
    const built = buildBirthdayCampaign({
      contacts: [{ id: "ct_1", name: "Ana", phone: "51999111222", day: 3, visits: 1, totalCents: 0, reachable: true }],
      flows: [],
      sends: [],
      manual: new Set(),
      bookings: [],
      sales: [],
      rescue: { claimed: new Set(["ct_1"]), runs: [{ contactId: "ct_1", status: "waiting" }], sends: [] },
    });
    const birthdays: SalonDashboardDto["birthdays"] = { month: 11, today: 27, year: 2026, ...built, rescue };
    return renderToStaticMarkup(createElement(BirthdaysSection, { birthdays, currency: "PEN", loading: false, hasData: true }));
  }
  const summary = (over: Partial<SalonDashboardDto["birthdays"]["rescue"]> = {}): SalonDashboardDto["birthdays"]["rescue"] => ({
    period: "2026-11",
    daysLeft: 3,
    suggested: true,
    eligible: 4,
    windowDays: 7,
    windowStartDay: 24,
    excluded: { opted_out: 1, no_conversation: 2, recent_visit: 0 },
    launched: 1,
    pending: 1,
    delivered: 0,
    failed: 0,
    booked: 0,
    converted: 0,
    conversionRate: null,
    revenueCents: 0,
    available: true,
    flows: [{ id: "aut_m", name: "Última oportunidad", greetingCopy: false }],
    benefit: "20% de descuento",
    monthEnd: "30 de noviembre",
    settings: { autoEnabled: false, flowId: null, windowDays: 7, minGapDays: 7, sendHour: 10, benefitText: null },
    lastAutoRunOn: null,
    ...over,
  });

  it("muestra alcance, exclusiones, resultado, botón y el estado del rescate por fila", async () => {
    const html = await render(summary());
    expect(html).toContain("Rescate de última oportunidad");
    expect(html).toContain("Quedan 3 días del mes");
    expect(html).toContain("Quedan fuera: 1 por baja, 2 sin chat de WhatsApp");
    expect(html).toContain("Enviar rescate a 4");
    expect(html).toContain("Lanzados 1");
    expect(html).toContain('data-rescate="pending"');
    expect(html).toContain("Rescate en cola");
    expect(html).toContain("Para rescatar");
  });

  it("sin nadie por rescatar el botón se apaga; sin Automatizaciones no hay bloque", async () => {
    expect(await render(summary({ eligible: 0 }))).toContain("Nadie por rescatar");
    expect(await render(summary({ available: false }))).not.toContain("Rescate de última oportunidad");
  });

  it("describeRescueResult resume encolados, omitidos por motivo y lo pendiente", async () => {
    const { describeRescueResult } = await import("@/components/negocio/dashboard-birthdays");
    expect(
      describeRescueResult({
        period: "2026-11",
        attempted: 3,
        enqueued: 2,
        skipped: [{ contactId: "x", reason: "already_rescued" }],
        remaining: 4,
      })
    ).toBe("2 rescates en cola · 1 omitido: ya recibió el rescate · quedan 4 por lanzar (vuelve a enviarlo)");
  });
});
