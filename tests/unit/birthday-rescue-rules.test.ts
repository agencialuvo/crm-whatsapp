import { beforeAll, describe, expect, it } from "vitest";
import { readBirthdayContext, renderVars } from "@/lib/automation";
import {
  buildBirthdayCampaign,
  closingWindowStartDay,
  computeRescueSummary,
  inClosingWindow,
  rescueBlock,
  visitedRecently,
} from "@/lib/salon/birthday-campaign";
import {
  benefitLabel,
  birthdayAlertCopy,
  birthdayAlertKey,
  buildBirthdayRunContext,
  classifyFailure,
  collectFailureAlerts,
  deadlineLabel,
  expectedGreetingMisses,
  GENERIC_BENEFIT,
  launchErrorReason,
  looksLikeBirthdayGreeting,
  manualBirthdayText,
  RESCUE_MESSAGE_SUGGESTION,
  rescueSettingsSchema,
  summarizeReasons,
} from "@/lib/salon/birthday-rescue";

/**
 * Cumpleaños — mejoras del rescate de fin de mes (reglas PURAS): mensaje sin felicitar fuera de fecha (beneficio y
 * plazo como variables), ventana de cierre y margen sin atención reciente, exclusiones y no duplicados, y los avisos
 * de la campanita por fallos o envíos que no se dispararon. Todo neutro de rubro.
 */

describe("ventana de cierre y margen sin atención reciente", () => {
  it("la ventana son los últimos N días del mes, contando hoy", () => {
    // Noviembre tiene 30: con 7 días, la ventana va del 24 al 30.
    expect(inClosingWindow("2026-11-23", 7)).toBe(false);
    expect(inClosingWindow("2026-11-24", 7)).toBe(true);
    expect(inClosingWindow("2026-11-30", 7)).toBe(true);
    expect(closingWindowStartDay("2026-11-10", 7)).toBe(24);
    // Febrero no bisiesto (28) y un día de ventana = solo el último día.
    expect(closingWindowStartDay("2027-02-01", 3)).toBe(26);
    expect(inClosingWindow("2026-11-29", 1)).toBe(false);
    expect(inClosingWindow("2026-11-30", 1)).toBe(true);
  });

  it("atención reciente: dentro del margen bloquea; en el límite o sin visitas, no; margen 0 apaga la regla", () => {
    // Ejemplo: se atendió el 28 y cumple el 30 → el 30 solo pasaron 2 días.
    expect(visitedRecently("2026-11-28", "2026-11-30", 7)).toBe(true);
    expect(visitedRecently("2026-11-23", "2026-11-30", 7)).toBe(false); // justo 7 días: ya cumple el margen
    expect(visitedRecently("2026-11-24", "2026-11-30", 7)).toBe(true);
    // Una atención del mes anterior también cuenta (no depende del mes ni de un servicio).
    expect(visitedRecently("2026-10-29", "2026-11-03", 7)).toBe(true);
    expect(visitedRecently(null, "2026-11-30", 7)).toBe(false);
    expect(visitedRecently("2026-11-29", "2026-11-30", 0)).toBe(false);
  });

  it("rescueBlock: cita vigente fuera del mes = «booked»; atención reciente = «recent_visit»; ya rescatado manda antes", () => {
    const base = { converted: false, booked: false, rescue: null, optedOut: false, reachable: true } as const;
    expect(rescueBlock({ ...base, upcomingBooking: true })).toBe("booked");
    expect(rescueBlock({ ...base, recentVisit: true })).toBe("recent_visit");
    expect(rescueBlock({ ...base, recentVisit: true, rescue: "failed" })).toBe("already_rescued");
    expect(rescueBlock({ ...base, recentVisit: true, optedOut: true })).toBe("recent_visit");
    expect(rescueBlock({ ...base, converted: true, upcomingBooking: true })).toBe("converted");
    expect(rescueBlock(base)).toBeNull();
  });

  it("buildBirthdayCampaign aplica el margen con el día del negocio y la cita vigente; el resumen cuenta la exclusión", () => {
    const row = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      name: id,
      phone: "51999111222",
      day: 6,
      visits: 0,
      totalCents: 0,
      reachable: true,
      ...over,
    });
    const built = buildBirthdayCampaign({
      contacts: [
        row("libre"),
        row("reciente", { lastVisit: "2026-10-28" }), // vino a fin del mes pasado (no es «aprovechó» del mes)
        row("antiguo", { lastVisit: "2026-09-01" }),
        row("vigente", { upcomingBooking: true }),
      ],
      flows: [],
      sends: [],
      manual: new Set(),
      bookings: [],
      sales: [],
      rescue: { claimed: new Set(), runs: [], sends: [] },
      rescueRules: { today: "2026-11-02", minGapDays: 7 },
    });
    expect(Object.fromEntries(built.clients.map((c) => [c.id, c.rescueBlock]))).toEqual({
      libre: null,
      reciente: "recent_visit",
      antiguo: null,
      vigente: "booked",
    });
    const s = computeRescueSummary(built.clients, "2026-11-02", 7);
    expect(s).toMatchObject({ eligible: 2, excluded: { recent_visit: 1, opted_out: 0, no_conversation: 0 }, suggested: false, windowStartDay: 24 });
    // Sin reglas (p. ej. una tarjeta vieja), el margen no se aplica.
    const sinReglas = buildBirthdayCampaign({
      contacts: [row("reciente", { lastVisit: "2026-11-01" })],
      flows: [],
      sends: [],
      manual: new Set(),
      bookings: [],
      sales: [],
    });
    expect(sinReglas.clients[0]!.rescueBlock).toBeNull();
  });
});

describe("mensaje del rescate: beneficio y plazo, sin felicitar fuera de fecha", () => {
  it("beneficio: el texto del negocio manda; si no, el descuento de Caja; si no, uno genérico", () => {
    expect(benefitLabel({ benefitText: "  una clase de cortesía ", birthdayEnabled: true, birthdayPercentage: 20 })).toBe("una clase de cortesía");
    expect(benefitLabel({ benefitText: null, birthdayEnabled: true, birthdayPercentage: 15 })).toBe("15% de descuento");
    expect(benefitLabel({ benefitText: "", birthdayEnabled: false, birthdayPercentage: 15 })).toBe(GENERIC_BENEFIT);
  });

  it("plazos legibles", () => {
    expect(deadlineLabel(0)).toBe("hoy es el último día");
    expect(deadlineLabel(1)).toBe("queda 1 día");
    expect(deadlineLabel(5)).toBe("quedan 5 días");
  });

  it("el contexto de la ejecución y las variables: alguien del día 6 rescatado el 28", () => {
    const ctx = buildBirthdayRunContext({ today: "2026-11-28", birthdayDay: 6, benefit: "20% de descuento" });
    expect(ctx).toEqual({ benefit: "20% de descuento", monthEnd: "30 de noviembre", daysLeft: 2, birthday: "6 de noviembre", birthdayPassed: true });
    // Pasa por el contexto JSON de la ejecución y vuelve igual.
    const read = readBirthdayContext(JSON.parse(JSON.stringify({ birthday: ctx })));
    expect(read).toEqual(ctx);
    const text = renderVars(RESCUE_MESSAGE_SUGGESTION, { name: "Ana", birthday: read });
    expect(text).toBe("Hola Ana, tu beneficio de cumpleaños sigue activo: 20% de descuento. Lo puedes usar hasta el 30 de noviembre (quedan 2 días). ¿Te reservo un espacio?");
    expect(looksLikeBirthdayGreeting(text)).toBe(false);
    expect(renderVars("{{cumple}} · {{dias_restantes}}", { name: null, birthday: read })).toBe("6 de noviembre · 2");
    // El último día del mes.
    const last = buildBirthdayRunContext({ today: "2026-11-30", birthdayDay: 30, benefit: "x" });
    expect(renderVars("{{plazo}}", { name: null, birthday: last })).toBe("hoy es el último día");
  });

  it("fuera de un rescate las variables salen vacías (nunca «undefined»); un contexto mal formado se ignora", () => {
    expect(renderVars("A{{beneficio}}B{{plazo}}C{{cierre_mes}}", { name: null })).toBe("ABC");
    expect(readBirthdayContext({ birthday: { benefit: 1 } })).toBeNull();
    expect(readBirthdayContext({ birthday: "x" })).toBeNull();
    expect(readBirthdayContext(null)).toBeNull();
  });

  it("detecta el «¡Feliz cumpleaños!» y parecidos, sin acentos ni mayúsculas; un recordatorio no salta", () => {
    for (const t of [
      "¡Feliz cumpleaños, {{nombre}}!",
      "FELIZ CUMPLE 🎉",
      "Feliz día, te esperamos",
      "Hoy es tu cumpleaños",
      "Happy birthday!",
      "Muchas felicidades de parte del equipo",
      "Que cumplas muchos más",
    ]) {
      expect(looksLikeBirthdayGreeting(t), t).toBe(true);
    }
    for (const t of [
      RESCUE_MESSAGE_SUGGESTION,
      "Tu beneficio de cumpleaños vence el {{cierre_mes}}",
      "Este mes es tu mes: reserva tu espacio",
      "",
      null,
    ]) {
      expect(looksLikeBirthdayGreeting(t), String(t)).toBe(false);
    }
  });

  it("saludo manual según el día: solo el mismo día felicita; si ya pasó, recuerda el beneficio y el cierre", () => {
    const base = { name: "Ana López", month: 11, today: "2026-11-08", benefit: "20% de descuento" };
    expect(manualBirthdayText({ ...base, day: 8 })).toContain("Feliz cumpleaños");
    const after = manualBirthdayText({ ...base, day: 6 });
    expect(looksLikeBirthdayGreeting(after)).toBe(false);
    expect(after).toContain("hasta el 30 de noviembre");
    expect(after).toContain("20% de descuento");
    const before = manualBirthdayText({ ...base, day: 20 });
    expect(looksLikeBirthdayGreeting(before)).toBe(false);
    expect(before).toContain("20 de noviembre");
  });

  it("ajustes: rangos, beneficio vacío = null, y el automático exige flujo", () => {
    const ok = rescueSettingsSchema.parse({ autoEnabled: false, flowId: null, windowDays: 7, minGapDays: 7, sendHour: 10, benefitText: "  " });
    expect(ok.benefitText).toBeNull();
    expect(rescueSettingsSchema.safeParse({ ...ok, autoEnabled: true }).success).toBe(false);
    expect(rescueSettingsSchema.safeParse({ ...ok, autoEnabled: true, flowId: "aut_1" }).success).toBe(true);
    expect(rescueSettingsSchema.safeParse({ ...ok, windowDays: 0 }).success).toBe(false);
    expect(rescueSettingsSchema.safeParse({ ...ok, minGapDays: 61 }).success).toBe(false);
    expect(rescueSettingsSchema.safeParse({ ...ok, sendHour: 24 }).success).toBe(false);
    expect(rescueSettingsSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});

describe("avisos de la campanita", () => {
  it("classifyFailure: entrega, rebote, errores del motor; la baja no es un fallo que avisar", () => {
    expect(classifyFailure({ logStatus: "success", messageStatus: "delivered" })).toBeNull();
    expect(classifyFailure({ logStatus: "success", messageStatus: "failed" })).toBe("delivery_failed");
    expect(classifyFailure({ logStatus: "skipped_opt_out" })).toBeNull();
    expect(classifyFailure({ runStatus: "cancelled", error: "skipped_opt_out" })).toBeNull();
    expect(classifyFailure({ logStatus: "failed", error: "out_of_window_requires_template: fuera de 24 h" })).toBe("out_of_window");
    expect(classifyFailure({ runStatus: "cancelled", error: "skipped_no_credit" })).toBe("no_credit");
    expect(classifyFailure({ runStatus: "cancelled", error: "skipped_rate_limit" })).toBe("rate_limit");
    expect(classifyFailure({ runStatus: "failed", error: "no_conversation" })).toBe("no_conversation");
    expect(classifyFailure({ runStatus: "failed", error: "meta_500: boom" })).toBe("send_error");
    expect(classifyFailure({ runStatus: "running" })).toBeNull();
  });

  it("collectFailureAlerts agrupa por tipo y flujo, sin contar a quien sí le llegó", () => {
    const send = (flowId: string, contactId: string, key: string, logStatus: string, messageStatus: string | null = null, error: string | null = null) => ({
      flowId,
      contactId,
      key,
      logStatus,
      messageStatus,
      error,
    });
    const alerts = collectFailureAlerts({
      sends: [
        send("f_saludo", "ana", "birthday:2026", "success", "failed"), // rebotó
        send("f_saludo", "beto", "birthday:2026", "success", "delivered"), // llegó
        send("f_saludo", "caro", "birthday:2026", "failed", null, "x"), // falló y luego…
        send("f_saludo", "caro", "birthday:2026", "success", "read"), // …llegó en el reintento: no se avisa
        send("f_rescate", "dani", "birthday_rescue:2026-11", "failed", null, "out_of_window_requires_template"),
        send("f_saludo", "eva", "birthday:2026", "skipped_opt_out"), // baja: no es problema
      ],
      runs: [
        { flowId: "f_rescate", contactId: "fede", key: "birthday_rescue:2026-11", status: "cancelled", error: "skipped_no_credit" },
        { flowId: "f_rescate", contactId: "gabi", key: "birthday_rescue:2026-11", status: "running", error: null },
      ],
    });
    expect(alerts).toEqual(
      expect.arrayContaining([
        { kind: "greeting_failed", flowId: "f_saludo", contactIds: ["ana"], reasons: ["delivery_failed"] },
        { kind: "rescue_failed", flowId: "f_rescate", contactIds: ["dani", "fede"], reasons: ["out_of_window", "no_credit"] },
      ])
    );
    expect(alerts).toHaveLength(2);
  });

  it("expectedGreetingMisses: el día de envío ya pasó y no hay ejecución; respeta la antigüedad y el «días antes»", () => {
    const misses = expectedGreetingMisses({
      today: "2026-11-15",
      year: 2026,
      flows: [
        { id: "f_dia", createdOn: "2026-01-01", daysOffset: 0 },
        { id: "f_nuevo", createdOn: "2026-11-12", daysOffset: 0 }, // creado después de la fecha de varios
        { id: "f_antes", createdOn: "2026-01-01", daysOffset: -2 }, // sale 2 días antes
      ],
      contacts: [
        { id: "ana", day: 10, month: 11, createdOn: "2026-01-01", reachable: true, optedOut: false },
        { id: "beto", day: 10, month: 11, createdOn: "2026-01-01", reachable: false, optedOut: false },
        { id: "caro", day: 16, month: 11, createdOn: "2026-01-01", reachable: true, optedOut: false }, // el de -2 ya tocaba (14)
        { id: "dani", day: 15, month: 11, createdOn: "2026-01-01", reachable: true, optedOut: false }, // hoy: aún puede salir
        { id: "eva", day: 5, month: 11, createdOn: "2026-11-10", reachable: true, optedOut: false }, // se registró después
        { id: "fede", day: 3, month: 11, createdOn: "2026-01-01", reachable: true, optedOut: true }, // baja
      ],
      started: new Set(["f_dia|ana", "f_antes|ana"]),
    });
    expect(misses).toEqual(
      expect.arrayContaining([
        { flowId: "f_dia", contactId: "beto", reason: "no_conversation" },
        { flowId: "f_antes", contactId: "beto", reason: "no_conversation" },
        { flowId: "f_antes", contactId: "caro", reason: "not_queued" },
        { flowId: "f_antes", contactId: "dani", reason: "not_queued" }, // su -2 fue el 13
      ])
    );
    expect(misses.some((m) => m.contactId === "ana")).toBe(false);
    expect(misses.some((m) => m.contactId === "eva" || m.contactId === "fede")).toBe(false);
    expect(misses.some((m) => m.flowId === "f_nuevo" && m.contactId === "beto")).toBe(false);
    expect(misses.some((m) => m.flowId === "f_dia" && m.contactId === "dani")).toBe(false);
  });

  it("textos del aviso: qué flujo, cuántos clientes y el motivo resumido", () => {
    const a = birthdayAlertCopy("rescue_failed", { flowName: "Última oportunidad", count: 3, reasons: ["delivery_failed", "delivery_failed", "no_credit"] });
    expect(a.title).toBe("Falló el rescate de cumpleaños");
    expect(a.message).toContain("«Última oportunidad»");
    expect(a.message).toContain("3 clientes");
    expect(a.message).toContain("WhatsApp no entregó el mensaje (2) · no hay monedas para la plantilla (1)");
    const b = birthdayAlertCopy("rescue_not_fired", { flowName: null, count: 1, reasons: ["flow_missing"] });
    expect(b.message).toContain("1 cliente ");
    expect(b.message).toContain("no hay un flujo elegido");
    expect(birthdayAlertCopy("greeting_not_fired", { flowName: "Saludo", count: 2, reasons: ["no_conversation"] }).message).toContain(
      "no se disparó para 2 clientes"
    );
    expect(summarizeReasons(["flow_inactive"])).toBe("el flujo está apagado");
    expect(birthdayAlertKey("greeting_failed", "f1", "2026-11")).toBe("greeting_failed:f1:2026-11");
    expect(birthdayAlertKey("rescue_not_fired", null, "2026-11", "flow_missing")).toBe("rescue_not_fired:-:2026-11:flow_missing");
    expect(launchErrorReason("not_found")).toBe("flow_missing");
    expect(launchErrorReason("greeting_copy")).toBe("greeting_copy");
    expect(launchErrorReason("raro")).toBe("send_error");
  });
});

describe("lanzamiento: ventana, texto del flujo y contexto del mensaje", () => {
  let mod: typeof import("@/server/business/birthday-rescue");
  beforeAll(async () => {
    mod = await import("@/server/business/birthday-rescue");
  }, 60_000);

  function deps(over: Partial<import("@/server/business/birthday-rescue").RescueDeps> = {}) {
    const enqueued: { contactId: string; context: Record<string, unknown> }[] = [];
    const claims: (string | null)[] = [];
    const d: import("@/server/business/birthday-rescue").RescueDeps = {
      loadFlow: async () => ({ id: "aut_m", triggerType: "manual", active: true }),
      flowGreets: async () => false,
      audience: async () => ({
        today: "2026-11-28",
        windowDays: 7,
        benefit: "una sesión de cortesía",
        clients: [{ id: "ct_6", day: 6, rescueBlock: null }],
      }),
      claim: async ({ userId }) => {
        claims.push(userId);
        return true;
      },
      release: async () => {},
      enqueue: async ({ contactId, context }) => {
        enqueued.push({ contactId, context });
        return true;
      },
      now: () => new Date("2026-11-28T15:00:00Z"),
      ...over,
    };
    return { d, enqueued, claims };
  }

  it("cada ejecución lleva el beneficio y el plazo; el automático entra sin usuario", async () => {
    const { d, enqueued, claims } = deps();
    const r = await mod.launchBirthdayRescue({ organizationId: "org_1", flowId: "aut_m", triggeredBy: null, source: "auto" }, d);
    expect(r.enqueued).toBe(1);
    expect(claims).toEqual([null]);
    expect(enqueued[0]!.context).toMatchObject({
      source: "birthday_rescue",
      mode: "auto",
      triggeredBy: "auto",
      birthday: { benefit: "una sesión de cortesía", monthEnd: "30 de noviembre", daysLeft: 2, birthday: "6 de noviembre", birthdayPassed: true },
    });
  });

  it("fuera de la ventana de cierre no sale (409 outside_window) y no reclama a nadie", async () => {
    const { d, claims } = deps({
      audience: async () => ({ today: "2026-11-10", windowDays: 7, benefit: "x", clients: [{ id: "ct_6", day: 6, rescueBlock: null }] }),
    });
    await expect(mod.launchBirthdayRescue({ organizationId: "org_1", flowId: "aut_m", triggeredBy: "usr_1" }, d)).rejects.toMatchObject({
      code: "outside_window",
      status: 409,
    });
    expect(claims).toEqual([]);
  });

  it("un flujo que felicita como si fuera el día no sirve para el rescate (422 greeting_copy), antes de tocar la audiencia", async () => {
    let asked = false;
    const { d } = deps({
      flowGreets: async () => true,
      audience: async () => {
        asked = true;
        return { today: "2026-11-28", windowDays: 7, benefit: "x", clients: [] };
      },
    });
    await expect(mod.launchBirthdayRescue({ organizationId: "org_1", flowId: "aut_m", triggeredBy: "usr_1" }, d)).rejects.toMatchObject({
      code: "greeting_copy",
      status: 422,
    });
    expect(asked).toBe(false);
  });
});

describe("tarjeta: acción manual como respaldo de la automatización", () => {
  let rowAction: (typeof import("@/components/negocio/dashboard-birthdays"))["rowAction"];
  beforeAll(async () => {
    ({ rowAction } = await import("@/components/negocio/dashboard-birthdays"));
  }, 60_000);
  const ctx = (automationActive: boolean) => ({ automationActive, todayISO: "2026-11-08", month: 11, benefit: "20% de descuento" });
  const c = (status: "sin_enviar" | "fallido", day: number, phone: string | null = "51999111222") => ({ status, day, phone, name: "Ana" });

  it("con automatización: a quien aún le toca no se le ofrece; si ya tocaba o falló, botón de respaldo", () => {
    expect(rowAction(c("sin_enviar", 8), ctx(true))).toEqual({ kind: "auto" });
    expect(rowAction(c("sin_enviar", 20), ctx(true))).toEqual({ kind: "auto" });
    expect(rowAction(c("sin_enviar", 5), ctx(true))).toMatchObject({ kind: "link", label: "Enviar a mano", backup: true, registers: true });
    expect(rowAction(c("fallido", 20), ctx(true))).toMatchObject({ kind: "link", label: "Reintentar a mano", backup: true });
    expect(rowAction(c("fallido", 20, null), ctx(true))).toEqual({ kind: "mark" });
  });

  it("sin automatización, «Saludar» es la acción normal; el texto no felicita si el cumpleaños ya pasó", () => {
    const passed = rowAction(c("sin_enviar", 6), ctx(false));
    expect(passed).toMatchObject({ kind: "link", label: "Saludar" });
    expect(passed).not.toHaveProperty("backup");
    const text = decodeURIComponent((passed as { href: string }).href.split("text=")[1]!);
    expect(looksLikeBirthdayGreeting(text)).toBe(false);
    expect(text).toContain("20% de descuento");
    const sameDay = rowAction(c("sin_enviar", 8), ctx(false)) as { href: string };
    expect(decodeURIComponent(sameDay.href.split("text=")[1]!)).toContain("Feliz cumpleaños");
  });
});
