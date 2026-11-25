import { describe, expect, it, vi } from "vitest";
import {
  delayConfigSchema,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  OUT_OF_WINDOW_ERROR,
  backoffMs,
  decideSend,
  delayToMs,
  renderVars,
  sendWhatsappConfigSchema,
  stepLabel,
} from "@/lib/automation";
import { parseAutomationsFlag } from "@/server/automation/flag";
import {
  classifyError,
  processRow,
  type Deps,
  type LogInput,
  type Row,
  type Step,
  type Target,
} from "@/server/automation/engine";

/**
 * Motor de automatizaciones — reglas puras y el procesado de UNA tarea con dobles. El bloqueo atómico
 * de la cola y la base de datos se prueban contra Postgres en `automation-queue.test.ts`.
 */

const NOW = new Date("2026-11-08T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("backoffMs", () => {
  it("duplica en cada intento: 30 s, 1 min, 2 min, 4 min…", () => {
    expect([1, 2, 3, 4, 5].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
  });
  it("tiene tope de 1 h aunque el contador sea enorme", () => {
    expect(backoffMs(30)).toBe(BACKOFF_MAX_MS);
    expect(backoffMs(10_000)).toBe(BACKOFF_MAX_MS);
  });
  it("un valor raro (0, negativo, NaN) cuenta como el primer intento", () => {
    for (const v of [0, -3, Number.NaN]) expect(backoffMs(v)).toBe(BACKOFF_BASE_MS);
  });
});

describe("decideSend (ventana de 24 h)", () => {
  const text = { content: "Hola" };
  const tpl = { templateId: "tpl_1" };
  it.each([
    ["dentro, con texto → texto", true, text, null, { kind: "text" }],
    ["dentro, con texto y plantilla → texto", true, { ...text, ...tpl }, "approved", { kind: "text" }],
    ["dentro, solo plantilla aprobada → plantilla", true, tpl, "approved", { kind: "template" }],
    ["dentro, solo plantilla pendiente → falla", true, tpl, "pending", { kind: "fail", error: "template_not_approved" }],
    ["fuera, plantilla aprobada → plantilla", false, tpl, "approved", { kind: "template" }],
    ["fuera, texto y plantilla aprobada → plantilla (no texto)", false, { ...text, ...tpl }, "approved", { kind: "template" }],
    ["fuera, solo texto → out_of_window", false, text, null, { kind: "fail", error: OUT_OF_WINDOW_ERROR }],
    ["fuera, plantilla rechazada → out_of_window", false, tpl, "rejected", { kind: "fail", error: OUT_OF_WINDOW_ERROR }],
    ["fuera, plantilla que no existe → out_of_window", false, tpl, null, { kind: "fail", error: OUT_OF_WINDOW_ERROR }],
    ["fuera, plantilla en borrador → out_of_window", false, tpl, "draft", { kind: "fail", error: OUT_OF_WINDOW_ERROR }],
  ])("%s", (_n, windowOpen, config, templateStatus, expected) => {
    expect(decideSend({ windowOpen, config, templateStatus })).toEqual(expected);
  });
});

describe("configuración de pasos y variables", () => {
  it("send_whatsapp exige mensaje o plantilla", () => {
    expect(sendWhatsappConfigSchema.safeParse({}).success).toBe(false);
    expect(sendWhatsappConfigSchema.safeParse({ content: "Hola" }).success).toBe(true);
    expect(sendWhatsappConfigSchema.safeParse({ templateId: "tpl_1" }).success).toBe(true);
  });
  it("convierte esperas a milisegundos", () => {
    expect(delayToMs({ amount: 45, unit: "seconds" })).toBe(45_000);
    expect(delayToMs({ amount: 30, unit: "minutes" })).toBe(1_800_000);
    expect(delayToMs({ amount: 2, unit: "hours" })).toBe(7_200_000);
    expect(delayToMs({ amount: 1, unit: "days" })).toBe(86_400_000);
  });
  it("renderVars rellena {{name}} y {{nombre}}, y sin nombre no deja huecos", () => {
    expect(renderVars("Hola {{name}}, feliz cumple", { name: "Ana" })).toBe("Hola Ana, feliz cumple");
    expect(renderVars("Hola {{ Nombre }}!", { name: "Luis" })).toBe("Hola Luis!");
    expect(renderVars("Hola {{name}} feliz", { name: null })).toBe("Hola feliz");
  });
  it("stepLabel usa el nombre del nodo o, si no tiene, su tipo", () => {
    expect(stepLabel("send_whatsapp", { name: "Felicitación" })).toBe("Felicitación");
    expect(stepLabel("delay", { amount: 1 })).toBe("delay");
    expect(stepLabel("delay", null)).toBe("delay");
  });
  it("la bandera solo enciende con valores explícitos", () => {
    expect(parseAutomationsFlag("on")).toBe(true);
    expect(parseAutomationsFlag(" TRUE ")).toBe(true);
    expect(parseAutomationsFlag(undefined)).toBe(false);
    expect(parseAutomationsFlag("off")).toBe(false);
    expect(parseAutomationsFlag("")).toBe(false);
  });
});

describe("classifyError", () => {
  const typed = (name: string, code: string) => Object.assign(new Error("x"), { name, code });
  it("solo Meta caída es recuperable entre los errores tipados", () => {
    expect(classifyError(typed("SendError", "meta_unavailable")).recoverable).toBe(true);
    expect(classifyError(typed("TemplateError", "meta_unavailable")).recoverable).toBe(true);
    for (const code of ["window_closed", "not_connected", "reconnect_required", "sandbox_violation", "text_too_long", "message_limit", "meta_error"]) {
      expect(classifyError(typed("SendError", code)).recoverable).toBe(false);
    }
    for (const code of ["invalid", "not_found", "meta_error"]) {
      expect(classifyError(typed("TemplateError", code)).recoverable).toBe(false);
    }
  });
  it("un error sin tipo (red, base de datos) se reintenta", () => {
    expect(classifyError(new Error("fetch failed"))).toMatchObject({ recoverable: true, code: "unexpected_error" });
    expect(classifyError("boom").recoverable).toBe(true);
  });
});

/* ─── processRow con dobles ─── */

const baseRow: Row = {
  id: "que_1",
  organizationId: "org_1",
  flowId: "aut_1",
  contactId: "ct_1",
  stepId: "stp_1",
  attempts: 1,
  maxAttempts: 5,
  bookingId: null,
};

function setup(over: {
  /** La cita de la tarea (flujos de cita); sin ella la tarea no es de una cita. */
  booking?: { status: string; scheduledAt: Date } | null;
  /** El disparador del flujo (decide qué estado de la cita lo mantiene vigente). */
  trigger?: string;
  timezone?: string;
  step?: Partial<Step> | null;
  target?: Partial<Target> | null;
  templateStatus?: string | null;
  flowActive?: boolean;
  alreadySucceeded?: boolean;
  row?: Partial<Row>;
  sendTextImpl?: Deps["sendText"];
  sendTemplateImpl?: Deps["sendTemplate"];
} = {}) {
  const logs: LogInput[] = [];
  const step: Step | null =
    over.step === null
      ? null
      : { id: "stp_1", flowId: "aut_1", stepType: "send_whatsapp", config: { name: "Cumple", content: "Hola {{name}}" }, ...over.step };
  const target: Target | null =
    over.target === null
      ? null
      : { conversationId: "cv_1", channel: "whatsapp", isTest: false, lastInboundAt: hoursAgo(1), contactName: "Ana", ...over.target };
  const deps = {
    now: () => NOW,
    loadStep: vi.fn(async () => step),
    isFlowActive: vi.fn(async () => over.flowActive ?? true),
    loadBooking: vi.fn(async () => (over.booking === undefined ? null : over.booking)),
    flowTriggerType: vi.fn(async () => over.trigger ?? "birthday"),
    timezone: vi.fn(async () => over.timezone ?? "UTC"),
    contactFacts: vi.fn(async () => ({ tagIds: [] as string[], stageId: null as string | null })),
    sendMedia: vi.fn(async () => ({ messageId: "msg_media" })),
    loadMedia: vi.fn(async () => ({ ok: true as const, bytes: 1, mimeType: "image/png", fileName: "a.png" })),
    isOptedOut: vi.fn(async () => false),
    recentAutomaticSends: vi.fn(async () => [] as Date[]),
    defer: vi.fn(async () => {}),
    applyTag: vi.fn(async () => "added" as const),
    moveContactToStage: vi.fn(async (_o: string, _c: string, stageId: string) => ({
      status: "moved" as const,
      toStageId: stageId,
      fromStageId: null as string | null,
    })),
    loadTarget: vi.fn(async () => target),
    templateStatus: vi.fn(async () => over.templateStatus ?? null),
    sendText: vi.fn(over.sendTextImpl ?? (async () => ({ messageId: "msg_1" }))),
    sendTemplate: vi.fn(over.sendTemplateImpl ?? (async () => ({ messageId: "msg_2" }))),
    waMessageIdOf: vi.fn(async (_o: string, id: string) => `wamid.${id}`),
    hasSuccessLog: vi.fn(async () => over.alreadySucceeded ?? false),
    writeLog: vi.fn(async (e: LogInput) => void logs.push(e)),
    completeAndAdvance: vi.fn(async () => null),
    markFailed: vi.fn(async () => undefined),
    markCancelled: vi.fn(async () => undefined),
    reschedule: vi.fn(async () => undefined),
  } satisfies Deps;
  const row = { ...baseRow, ...over.row };
  return { deps, logs, row, run: () => processRow(row, deps) };
}

describe("processRow — ventana de 24 h", () => {
  it("dentro de la ventana envía el texto con el nombre y lo registra con foto del nodo y wamid", async () => {
    const t = setup();
    expect(await t.run()).toBe("completed");
    expect(t.deps.sendText).toHaveBeenCalledWith({ organizationId: "org_1", conversationId: "cv_1", text: "Hola Ana" });
    expect(t.deps.sendTemplate).not.toHaveBeenCalled();
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, NOW);
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).toMatchObject({ status: "success", queueId: "que_1", stepId: "stp_1" });
    expect(t.logs[0]!.metadata).toMatchObject({
      step: { stepType: "send_whatsapp", stepName: "Cumple", config: { content: "Hola {{name}}" } },
      waMessageId: "wamid.msg_1",
      payload: { mode: "text", text: "Hola Ana" },
    });
  });

  it("fuera de la ventana sin plantilla marca la tarea failed con out_of_window_requires_template y NO envía", async () => {
    const t = setup({ target: { lastInboundAt: hoursAgo(30) } });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, OUT_OF_WINDOW_ERROR);
    expect(t.deps.sendText).not.toHaveBeenCalled();
    expect(t.deps.sendTemplate).not.toHaveBeenCalled();
    expect(t.logs[0]).toMatchObject({ status: "failed" });
    expect(t.logs[0]!.metadata).toMatchObject({ error: OUT_OF_WINDOW_ERROR, windowOpen: false });
  });

  it("sin ningún mensaje entrante (ventana cerrada) también exige plantilla", async () => {
    const t = setup({ target: { lastInboundAt: null } });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, OUT_OF_WINDOW_ERROR);
  });

  it("fuera de la ventana con plantilla NO aprobada falla con el mismo error", async () => {
    const t = setup({
      step: { config: { content: "Hola", templateId: "tpl_9" } },
      target: { lastInboundAt: hoursAgo(48) },
      templateStatus: "pending",
    });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, OUT_OF_WINDOW_ERROR);
    expect(t.deps.sendTemplate).not.toHaveBeenCalled();
  });

  it("fuera de la ventana con plantilla aprobada la envía con las variables rellenas", async () => {
    const t = setup({
      step: { config: { templateId: "tpl_1", variables: ["{{name}}", "10%"] } },
      target: { lastInboundAt: hoursAgo(48) },
      templateStatus: "approved",
    });
    expect(await t.run()).toBe("completed");
    expect(t.deps.sendTemplate).toHaveBeenCalledWith({
      organizationId: "org_1",
      conversationId: "cv_1",
      templateId: "tpl_1",
      variables: ["Ana", "10%"],
    });
    expect(t.deps.sendText).not.toHaveBeenCalled();
    expect(t.logs[0]!.metadata).toMatchObject({ payload: { mode: "template", templateId: "tpl_1" }, windowOpen: false });
  });
});

describe("processRow — guardas", () => {
  it("una conversación del Laboratorio jamás envía (sandbox)", async () => {
    const t = setup({ target: { isTest: true } });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "sandbox_conversation");
    expect(t.deps.sendText).not.toHaveBeenCalled();
  });
  it("un contacto de otro canal (Instagram…) no recibe WhatsApp", async () => {
    const t = setup({ target: { channel: "instagram" } });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "not_whatsapp_channel");
  });
  it("sin conversación del contacto, falla", async () => {
    const t = setup({ target: null });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "no_conversation");
  });
  it("un flujo apagado cancela lo que ya estaba en cola, sin enviar", async () => {
    const t = setup({ flowActive: false });
    expect(await t.run()).toBe("cancelled");
    expect(t.deps.markCancelled).toHaveBeenCalledWith(t.row, "flow_inactive");
    expect(t.deps.sendText).not.toHaveBeenCalled();
  });
  it("un paso que ya no existe falla sin tocar nada más", async () => {
    const t = setup({ step: null });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "step_not_found");
    expect(t.logs).toHaveLength(0);
  });
  it("una configuración inválida falla a la vista", async () => {
    const t = setup({ step: { config: { name: "vacío" } } });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "invalid_step_config");
  });
  it("un tipo de paso sin ejecutor no se da por hecho en silencio", async () => {
    for (const stepType of ["tipo_inventado", "webhook"]) {
      const t = setup({ step: { stepType } });
      expect(await t.run()).toBe("failed");
      expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "step_type_not_supported");
    }
  });
});

describe("processRow — idempotencia", () => {
  it("si la tarea ya registró su éxito, NO vuelve a enviar: solo la cierra y avanza", async () => {
    const t = setup({ alreadySucceeded: true });
    expect(await t.run()).toBe("completed");
    expect(t.deps.sendText).not.toHaveBeenCalled();
    expect(t.deps.writeLog).not.toHaveBeenCalled();
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, NOW);
  });
});

describe("processRow — reintentos con backoff", () => {
  const down = () => Object.assign(new Error("Meta no está disponible ahora"), { name: "SendError", code: "meta_unavailable" });

  it("una caída recuperable reprograma con backoff exponencial según el intento", async () => {
    for (const attempts of [1, 2, 3]) {
      const t = setup({ row: { attempts }, sendTextImpl: async () => { throw down(); } });
      expect(await t.run()).toBe("retry");
      expect(t.deps.reschedule).toHaveBeenCalledWith(
        t.row,
        new Date(NOW.getTime() + backoffMs(attempts)),
        expect.stringContaining("meta_unavailable")
      );
      expect(t.deps.markFailed).not.toHaveBeenCalled();
      expect(t.logs).toHaveLength(0); // un reintento no ensucia la auditoría
    }
  });

  it("al agotar max_attempts pasa a failed (con la auditoría del fallo)", async () => {
    const t = setup({ row: { attempts: 5, maxAttempts: 5 }, sendTextImpl: async () => { throw down(); } });
    expect(await t.run()).toBe("failed");
    expect(t.deps.reschedule).not.toHaveBeenCalled();
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, expect.stringContaining("max_attempts_exceeded"));
    expect(t.logs[0]).toMatchObject({ status: "failed" });
    expect(t.logs[0]!.metadata).toMatchObject({ step: { stepType: "send_whatsapp" } });
  });

  it("un error de red sin tipo también se reintenta", async () => {
    const t = setup({ sendTextImpl: async () => { throw new Error("fetch failed"); } });
    expect(await t.run()).toBe("retry");
    expect(t.deps.reschedule).toHaveBeenCalled();
  });

  it("un rechazo definitivo (Meta lo rechazó) NO se reintenta", async () => {
    const t = setup({
      sendTextImpl: async () => { throw Object.assign(new Error("número inválido"), { name: "SendError", code: "meta_error" }); },
    });
    expect(await t.run()).toBe("failed");
    expect(t.deps.reschedule).not.toHaveBeenCalled();
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, expect.stringContaining("meta_error"));
  });
});

describe("processRow — esperas", () => {
  it("delay encola el siguiente paso para dentro del tiempo configurado y lo registra", async () => {
    const t = setup({ step: { stepType: "delay", config: { amount: 2, unit: "hours" } } });
    expect(await t.run()).toBe("completed");
    const nextAt = new Date(NOW.getTime() + 2 * 3_600_000);
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, nextAt);
    expect(t.deps.sendText).not.toHaveBeenCalled();
    expect(t.logs[0]).toMatchObject({ status: "success" });
    expect(t.logs[0]!.metadata).toMatchObject({ nextAt: nextAt.toISOString(), step: { stepType: "delay" } });
  });
  it("delay en segundos encola el siguiente paso con precisión de segundos", async () => {
    const t = setup({ step: { stepType: "delay", config: { amount: 45, unit: "seconds" } } });
    expect(await t.run()).toBe("completed");
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, new Date(NOW.getTime() + 45_000));
  });
  it("delay en segundos respeta la ventana horaria del negocio: espera 30 s y sale a la próxima hora fija local", async () => {
    // NOW = 12:00 UTC = 06:00 en Ciudad de México (UTC-6, sin horario de verano en esa fecha). «A las 10:00» → 16:00 UTC del mismo día.
    const t = setup({ timezone: "America/Mexico_City", step: { stepType: "delay", config: { amount: 30, unit: "seconds", window: { mode: "at", hour: 10, minute: 0 } } } });
    expect(await t.run()).toBe("completed");
    const nextAt = (t.deps.completeAndAdvance.mock.calls[0] as unknown as [unknown, Date])[1];
    expect(nextAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 30_000);
    expect(nextAt.toISOString()).toBe(`${NOW.toISOString().slice(0, 10)}T16:00:00.000Z`);
    expect(t.deps.timezone).toHaveBeenCalledWith("org_1");
  });
  it("delay en segundos sin ventana no consulta la zona horaria (solo suma los segundos)", async () => {
    const t = setup({ step: { stepType: "delay", config: { amount: 1, unit: "seconds" } } });
    expect(await t.run()).toBe("completed");
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, new Date(NOW.getTime() + 1_000));
    expect(t.deps.timezone).not.toHaveBeenCalled();
  });
  it("delay valida el tope por unidad (3600 en segundos, 366 en el resto)", () => {
    const ok = (amount: number, unit: string) => delayConfigSchema.safeParse({ amount, unit }).success;
    expect(ok(3600, "seconds")).toBe(true);
    expect(ok(3601, "seconds")).toBe(false);
    expect(ok(366, "minutes")).toBe(true);
    expect(ok(367, "minutes")).toBe(false);
    expect(ok(367, "hours")).toBe(false);
    expect(ok(367, "days")).toBe(false);
    expect(ok(0, "seconds")).toBe(false);
  });
  it("una espera inválida falla a la vista", async () => {
    const t = setup({ step: { stepType: "delay", config: { amount: -1, unit: "hours" } } });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "invalid_step_config");
  });
});

/* ─── Citas: vigencia, espera anclada, ventana horaria y variables ─── */

describe("processRow — citas", () => {
  const bookingIn = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
  const waitStep = (cfg: Record<string, unknown> = {}): Partial<Step> => ({
    stepType: "wait_until",
    config: { anchor: "booking.scheduledAt", offsetMinutes: -1440, ...cfg },
  });
  const cita = { row: { bookingId: "bk_1" } };

  it("una cita cancelada, realizada o inexistente cancela la tarea sin enviar nada", async () => {
    for (const [booking, reason] of [
      [{ status: "cancelada", scheduledAt: bookingIn(48) }, "booking_not_active"],
      [{ status: "realizada", scheduledAt: bookingIn(48) }, "booking_not_active"],
      [null, "booking_not_found"],
    ] as const) {
      const t = setup({ booking, trigger: "booking_created", ...cita });
      expect(await t.run()).toBe("cancelled");
      expect(t.deps.markCancelled).toHaveBeenCalledWith(t.row, reason);
      expect(t.deps.sendText).not.toHaveBeenCalled();
      expect(t.logs).toHaveLength(0);
    }
  });

  it("una cita agendada sigue su camino y envía", async () => {
    const t = setup({ booking: { status: "agendada", scheduledAt: bookingIn(48) }, trigger: "booking_created", ...cita });
    expect(await t.run()).toBe("completed");
    expect(t.deps.sendText).toHaveBeenCalledTimes(1);
  });

  it("un flujo de no-show exige que la cita siga marcada como no-show", async () => {
    const vigente = setup({ booking: { status: "no_show", scheduledAt: bookingIn(-2) }, trigger: "booking_no_show", ...cita });
    expect(await vigente.run()).toBe("completed");
    const reabierta = setup({ booking: { status: "agendada", scheduledAt: bookingIn(-2) }, trigger: "booking_no_show", ...cita });
    expect(await reabierta.run()).toBe("cancelled");
    expect(reabierta.deps.markCancelled).toHaveBeenCalledWith(reabierta.row, "booking_no_longer_no_show");
  });

  it("una tarea que no es de una cita no consulta ninguna", async () => {
    const t = setup();
    await t.run();
    expect(t.deps.loadBooking).not.toHaveBeenCalled();
    expect(t.deps.flowTriggerType).not.toHaveBeenCalled();
  });

  it("wait_until: el paso siguiente queda programado para la hora anclada a la cita", async () => {
    const scheduledAt = bookingIn(72); // 2026-11-11T12:00Z
    const t = setup({ step: waitStep(), booking: { status: "agendada", scheduledAt }, trigger: "booking_created", ...cita });
    expect(await t.run()).toBe("completed");
    const nextAt = new Date(scheduledAt.getTime() - 24 * 3_600_000);
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, nextAt);
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).toMatchObject({ status: "success", metadata: { bookingId: "bk_1", nextAt: nextAt.toISOString() } });
    expect(t.deps.sendText).not.toHaveBeenCalled();
  });

  it("wait_until ya es tarde: sale por el asa «late»; a qué lleva (omitir, continuar, terminar) lo deciden las aristas", async () => {
    const booking = { status: "agendada", scheduledAt: bookingIn(10) }; // «1 día antes» ya pasó
    for (const lateAction of ["skip_next", "continue", "stop"] as const) {
      const t = setup({ step: waitStep({ lateAction }), booking, trigger: "booking_created", ...cita });
      expect(await t.run()).toBe("completed");
      expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, NOW, { handle: "late" });
      expect(t.logs[0]!.metadata).toMatchObject({ late: true, lateAction, handle: "late" });
    }
  });

  it("wait_until respeta la ventana horaria en la zona del negocio", async () => {
    // Cita en 72 h = 11-nov 12:00Z (07:00 en Lima). «1 día antes» = 10-nov 07:00 Lima; a las 10:00 fijas → 15:00Z.
    const t = setup({
      step: waitStep({ window: { mode: "at", hour: 10, minute: 0 } }),
      booking: { status: "agendada", scheduledAt: bookingIn(72) },
      trigger: "booking_created",
      timezone: "America/Lima",
      ...cita,
    });
    await t.run();
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, new Date("2026-11-10T15:00:00.000Z"));
  });

  it("wait_until sin cita (flujo que no es de citas) falla a la vista", async () => {
    const t = setup({ step: waitStep() });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "wait_until_requires_booking");
  });

  it("wait_until con configuración inválida falla a la vista", async () => {
    const t = setup({
      step: { stepType: "wait_until", config: { anchor: "lead.createdAt", offsetMinutes: -60 } },
      booking: { status: "agendada", scheduledAt: bookingIn(72) },
      trigger: "booking_created",
      ...cita,
    });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "invalid_step_config");
  });

  it("«Esperar» con ventana: no sale de madrugada, espera a la apertura", async () => {
    // NOW + 1 día = 9-nov 12:00Z = 07:00 en Lima → antes de las 09:00 → 09:00 Lima = 14:00Z.
    const t = setup({
      step: { stepType: "delay", config: { amount: 1, unit: "days", window: { mode: "between", fromHour: 9, toHour: 21 } } },
      timezone: "America/Lima",
    });
    expect(await t.run()).toBe("completed");
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, new Date("2026-11-09T14:00:00.000Z"));
  });

  it("«Esperar» sin ventana sigue igual y no pide la zona horaria", async () => {
    const t = setup({ step: { stepType: "delay", config: { amount: 2, unit: "hours" } } });
    await t.run();
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, new Date(NOW.getTime() + 2 * 3_600_000));
    expect(t.deps.timezone).not.toHaveBeenCalled();
  });

  it("el mensaje de un flujo de cita dice cuándo es: {{fecha}} y {{hora}} en la zona del negocio", async () => {
    // 9-nov 20:00Z = 15:00 en Lima; «ahora» (8-nov 12:00Z = 07:00 Lima) → «mañana».
    const t = setup({
      step: { config: { name: "Recordatorio", content: "Hola {{name}}, tu cita es {{fecha}} a las {{hora}}." } },
      booking: { status: "agendada", scheduledAt: new Date("2026-11-09T20:00:00.000Z") },
      trigger: "booking_created",
      timezone: "America/Lima",
      ...cita,
    });
    expect(await t.run()).toBe("completed");
    const text = (t.deps.sendText as ReturnType<typeof vi.fn>).mock.calls[0]![0].text as string;
    expect(text).toContain("Hola Ana");
    expect(text).toContain("mañana");
    expect(text).toContain("9 de noviembre");
    expect(text).toContain("15:00");
  });
});
