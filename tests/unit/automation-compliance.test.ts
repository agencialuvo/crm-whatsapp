import { describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_RATE_LIMIT,
  RATE_LIMIT_MAX_HOLD_MS,
  decideRateLimit,
  detectOptOutIntent,
  normalizeForMatch,
  rateLimitHoldExpired,
} from "@/lib/automation-compliance";
import { OUT_OF_WINDOW_MEDIA_ERROR, sendMediaConfigSchema } from "@/lib/automation";
import { stepCreateSchema } from "@/lib/automation-schemas";
import { describeStep } from "@/lib/automation-dto";
import { PALETTE, nodeKindOf } from "@/lib/automation-canvas";
import { handlesOf, validateGraph } from "@/lib/automation-graph";
import { processRow, type Deps, type LogInput, type MediaFile, type Row, type Step, type Target } from "@/server/automation/engine";
import { onInboundOptOut, type OptOutDeps } from "@/server/automation/opt-out";

/**
 * Fase 6 (spec 037) — reglas puras de cumplimiento y el bloque `send_media`: qué es una baja, el tope de frecuencia,
 * y el motor con dobles (baja → no envía; límite → pospone sin gastar intento; media → envía por la vía de las personas).
 */

const NOW = new Date("2026-11-08T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

/* ─── Detección de bajas ─── */

describe("detectOptOutIntent", () => {
  it.each(["baja", "BAJA", "Baja.", "¡baja!", "stop", "STOP", "Stop!", "unsubscribe", "Unsubscribe", "cancelar suscripción", "stop all"])(
    "«%s» es una baja",
    (t) => expect(detectOptOutIntent(t)).toBe("opt_out")
  );

  it.each([
    "no quiero más mensajes",
    "No quiero más mensajes, gracias",
    "por favor no me escriban más",
    "Quiero darme de baja",
    "dar de baja mi número",
    "deja de escribirme",
    "DEJEN DE ENVIARME MENSAJES",
    "no me manden más promociones",
    "do not contact me",
  ])("la frase «%s» es una baja", (t) => expect(detectOptOutIntent(t)).toBe("opt_out"));

  it("ignora acentos, mayúsculas y signos", () => {
    expect(normalizeForMatch("  ¡Quiero DARME de BAJA!!  ")).toBe("quiero darme de baja");
    expect(detectOptOutIntent("NO QUIERO MÁS MENSAJES")).toBe("opt_out");
  });

  it.each([
    "tengo la presión baja",
    "la tarifa es baja?",
    "baja el precio por favor",
    "stop it, estoy ocupado ahora mismo, te escribo luego y vemos lo de la cita del jueves por la tarde",
    "cancelar", // es lo que se contesta a un recordatorio para cancelar la CITA, no una baja
    "quiero cancelar mi cita",
    "hola",
    "gracias, no quiero cambiar la cita",
    "",
  ])("«%s» NO es una baja", (t) => expect(detectOptOutIntent(t)).toBeNull());

  it("un texto ausente no es nada", () => {
    expect(detectOptOutIntent(null)).toBeNull();
    expect(detectOptOutIntent(undefined)).toBeNull();
  });

  it("un mensaje largo es conversación: no se interpreta aunque contenga la frase", () => {
    const largo = `${"cuéntame más sobre el servicio y los horarios disponibles. ".repeat(3)}no quiero más mensajes`;
    expect(detectOptOutIntent(largo)).toBeNull();
  });

  it.each(["start", "START", "reanudar", "suscribirme", "quiero recibir mensajes", "Quiero volver a recibir mensajes"])(
    "«%s» levanta la baja",
    (t) => expect(detectOptOutIntent(t)).toBe("opt_in")
  );
});

describe("onInboundOptOut", () => {
  function deps(over: Partial<OptOutDeps> = {}) {
    const d = {
      enabled: vi.fn(() => true),
      apply: vi.fn(async () => ({ found: true, changed: true, cancelledRuns: 1 })),
      clear: vi.fn(async () => true),
      ...over,
    } satisfies OptOutDeps;
    return d;
  }
  const ev = (text: string | null) => ({ organizationId: "org_1", contactId: "ct_1", text });

  it("«STOP» da de baja por palabra clave", async () => {
    const d = deps();
    expect(await onInboundOptOut(ev("STOP"), d)).toBe("opt_out");
    expect(d.apply).toHaveBeenCalledWith({ organizationId: "org_1", contactId: "ct_1", source: "keyword", detail: "STOP" });
    expect(d.clear).not.toHaveBeenCalled();
  });
  it("«start» levanta la baja", async () => {
    const d = deps();
    expect(await onInboundOptOut(ev("start"), d)).toBe("opt_in");
    expect(d.clear).toHaveBeenCalledWith("org_1", "ct_1");
    expect(d.apply).not.toHaveBeenCalled();
  });
  it("un mensaje cualquiera, un sticker o el módulo apagado no tocan nada", async () => {
    const d = deps();
    expect(await onInboundOptOut(ev("hola, quiero una cita"), d)).toBeNull();
    expect(await onInboundOptOut(ev(null), d)).toBeNull();
    const off = deps({ enabled: vi.fn(() => false) });
    expect(await onInboundOptOut(ev("stop"), off)).toBeNull();
    expect(d.apply).not.toHaveBeenCalled();
    expect(off.apply).not.toHaveBeenCalled();
  });
  it("nunca lanza: un fallo de la base no tumba la ingesta del mensaje", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({ apply: vi.fn(async () => Promise.reject(new Error("db caída"))) });
    expect(await onInboundOptOut(ev("baja"), d)).toBeNull();
    spy.mockRestore();
  });
});

/* ─── Límite de frecuencia ─── */

describe("decideRateLimit", () => {
  const max = AUTOMATION_RATE_LIMIT.maxMessages;
  it("sin envíos, cabe", () => {
    expect(decideRateLimit({ sentAt: [], now: NOW })).toEqual({ allowed: true, used: 0 });
  });
  it("con uno menos que el tope, cabe; con el tope exacto, no", () => {
    const some = Array.from({ length: max - 1 }, (_, i) => hoursAgo(i + 1));
    expect(decideRateLimit({ sentAt: some, now: NOW })).toEqual({ allowed: true, used: max - 1 });
    const full = Array.from({ length: max }, (_, i) => hoursAgo(i + 1));
    expect(decideRateLimit({ sentAt: full, now: NOW })).toMatchObject({ allowed: false, used: max });
  });
  it("la ventana es móvil: lo que salió hace más de 24 h no cuenta", () => {
    const old = Array.from({ length: max + 3 }, (_, i) => hoursAgo(25 + i));
    expect(decideRateLimit({ sentAt: old, now: NOW })).toEqual({ allowed: true, used: 0 });
    // Justo en el borde (exactamente 24 h) ya salió de la ventana.
    expect(decideRateLimit({ sentAt: [hoursAgo(24)], now: NOW, maxMessages: 1 })).toEqual({ allowed: true, used: 0 });
  });
  it("retryAt es cuando el envío que estorba sale de la ventana", () => {
    // Tope 3; salieron hace 20 h, 10 h y 2 h: hay hueco cuando salga el de hace 20 h (en 4 h).
    const r = decideRateLimit({ sentAt: [hoursAgo(2), hoursAgo(20), hoursAgo(10)], now: NOW, maxMessages: 3 });
    expect(r).toMatchObject({ allowed: false, used: 3 });
    expect(r.allowed === false && r.retryAt.getTime()).toBe(NOW.getTime() + 4 * 3_600_000);
  });
  it("si ya hay MÁS que el tope (ráfaga previa), espera a que salgan los suficientes", () => {
    // Tope 2 y 4 envíos (hace 23, 22, 21, 1 h): hace falta que salgan 3; el 3.º más antiguo (hace 21 h) sale en 3 h.
    const r = decideRateLimit({ sentAt: [hoursAgo(1), hoursAgo(21), hoursAgo(22), hoursAgo(23)], now: NOW, maxMessages: 2 });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false && r.retryAt.getTime()).toBe(NOW.getTime() + 3 * 3_600_000);
  });
  it("retenida más de 24 h se descarta", () => {
    expect(rateLimitHoldExpired(new Date(NOW.getTime() - RATE_LIMIT_MAX_HOLD_MS + 1000), NOW)).toBe(false);
    expect(rateLimitHoldExpired(new Date(NOW.getTime() - RATE_LIMIT_MAX_HOLD_MS - 1000), NOW)).toBe(true);
  });
});

/* ─── send_media: contrato, paleta y nodo ─── */

describe("send_media — contrato", () => {
  it("pide un archivo; la leyenda es opcional y acotada a 1024", () => {
    expect(sendMediaConfigSchema.safeParse({}).success).toBe(false);
    expect(sendMediaConfigSchema.safeParse({ mediaId: "" }).success).toBe(false);
    expect(sendMediaConfigSchema.safeParse({ mediaId: "med_1" }).success).toBe(true);
    expect(sendMediaConfigSchema.safeParse({ mediaId: "med_1", caption: "x".repeat(1024) }).success).toBe(true);
    expect(sendMediaConfigSchema.safeParse({ mediaId: "med_1", caption: "x".repeat(1025) }).success).toBe(false);
  });
  it("la API de pasos lo acepta como un tipo más", () => {
    const ok = stepCreateSchema.safeParse({ stepType: "send_media", config: { mediaId: "med_1", caption: "Hola {{name}}" } });
    expect(ok.success).toBe(true);
    expect(stepCreateSchema.safeParse({ stepType: "send_media", config: {} }).success).toBe(false);
  });
  it("tiene una sola salida y no ramifica", () => {
    expect(handlesOf("send_media")).toEqual(["default"]);
  });
  it("el grafo lo valida como cualquier paso", () => {
    const v = validateGraph({
      nodes: [
        { id: "trigger", type: "trigger", config: { triggerType: "manual", triggerConfig: null } },
        { id: "m", type: "send_media", config: { mediaId: "med_1" } },
        { id: "bad", type: "send_media", config: {} },
      ],
      edges: [
        { source: "trigger", target: "m", sourceHandle: "default" },
        { source: "m", target: "bad", sourceHandle: "default" },
      ],
    });
    expect(v.errors.map((e) => e.code)).toContain("invalid_config");
    expect(v.errors.filter((e) => e.code === "invalid_config")[0]!.nodeIds).toEqual(["bad"]);
  });
  it("describeStep muestra el archivo, su tipo y la leyenda; distingue «sin elegir» de «ya no existe»", () => {
    const media = [{ id: "med_1", nombre: "Promo", tipo: "video" as const, ruta: "/api/medios/med_1/archivo" }];
    expect(describeStep({ stepType: "send_media", config: { mediaId: "med_1", caption: "Mira" } }, [], { media })).toEqual({
      title: "Video «Promo»",
      detail: "«Mira»",
    });
    expect(describeStep({ stepType: "send_media", config: {} }, [], { media }).title).toContain("(sin elegir)");
    expect(describeStep({ stepType: "send_media", config: { mediaId: "med_x" } }, [], { media }).title).toContain("(ya no existe)");
  });
});

describe("send_media — paleta", () => {
  it("«Enviar multimedia» ya no es «Próximamente»: se puede soltar en el lienzo", () => {
    const item = PALETTE.find((p) => p.id === "step:send_media");
    expect(item).toMatchObject({ kind: "step", stepType: "send_media", label: "Enviar multimedia" });
    expect(item?.soon).toBeFalsy();
    expect(PALETTE.some((p) => p.soon)).toBe(false);
    expect(PALETTE.some((p) => p.id === "soon:media")).toBe(false);
  });
  it("se dibuja con su nodo propio", () => {
    expect(nodeKindOf("send_media")).toBe("media");
  });
});

/* ─── Motor con dobles ─── */

const baseRow: Row = {
  id: "que_1",
  organizationId: "org_1",
  flowId: "aut_1",
  contactId: "ct_1",
  stepId: "stp_1",
  attempts: 1,
  maxAttempts: 5,
  bookingId: null,
  createdAt: hoursAgo(0),
};

function setup(over: {
  step?: Partial<Step>;
  target?: Partial<Target>;
  optedOut?: boolean;
  sent?: Date[];
  media?: MediaFile;
  alreadySucceeded?: boolean;
  row?: Partial<Row>;
} = {}) {
  const logs: LogInput[] = [];
  const step: Step = {
    id: "stp_1",
    flowId: "aut_1",
    stepType: "send_whatsapp",
    config: { content: "Hola {{name}}" },
    ...over.step,
  };
  const target: Target = {
    conversationId: "cv_1",
    channel: "whatsapp",
    isTest: false,
    lastInboundAt: hoursAgo(1),
    contactName: "Ana",
    ...over.target,
  };
  const deps = {
    now: () => NOW,
    loadStep: vi.fn(async () => step),
    isFlowActive: vi.fn(async () => true),
    loadBooking: vi.fn(async () => null),
    flowTriggerType: vi.fn(async () => "manual"),
    timezone: vi.fn(async () => "UTC"),
    contactFacts: vi.fn(async () => ({ tagIds: [] as string[], stageId: null as string | null })),
    applyTag: vi.fn(async () => "added" as const),
    moveContactToStage: vi.fn(async (_o: string, _c: string, stageId: string) => ({
      status: "moved" as const,
      toStageId: stageId,
      fromStageId: null as string | null,
    })),
    loadTarget: vi.fn(async () => target),
    templateStatus: vi.fn(async () => null),
    sendText: vi.fn(async () => ({ messageId: "msg_1" })),
    sendTemplate: vi.fn(async () => ({ messageId: "msg_2" })),
    sendMedia: vi.fn(async (_input: Parameters<Deps["sendMedia"]>[0]) => ({ messageId: "msg_media" })),
    loadMedia: vi.fn(async (): Promise<MediaFile> => over.media ?? { ok: true, bytes: 9, mimeType: "image/png", fileName: "promo.png" }),
    isOptedOut: vi.fn(async () => over.optedOut ?? false),
    recentAutomaticSends: vi.fn(async () => over.sent ?? []),
    defer: vi.fn(async () => undefined),
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

const MEDIA_STEP = { stepType: "send_media", config: { name: "Promo", mediaId: "med_1", caption: "Hola {{name}}, mira esto" } };

describe("motor — baja (skipped_opt_out)", () => {
  it.each([
    ["send_whatsapp", { content: "Hola" }],
    ["send_media", { mediaId: "med_1" }],
  ])("un contacto dado de baja NO recibe %s: se registra la omisión y la ejecución termina", async (stepType, config) => {
    const t = setup({ optedOut: true, step: { stepType, config } });
    expect(await t.run()).toBe("cancelled");
    expect(t.deps.sendText).not.toHaveBeenCalled();
    expect(t.deps.sendTemplate).not.toHaveBeenCalled();
    expect(t.deps.sendMedia).not.toHaveBeenCalled();
    expect(t.deps.markCancelled).toHaveBeenCalledWith(t.row, "skipped_opt_out");
    // Frena el flujo: no avanza al paso siguiente.
    expect(t.deps.completeAndAdvance).not.toHaveBeenCalled();
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).toMatchObject({ status: "skipped_opt_out", queueId: "que_1", stepId: "stp_1" });
    expect(t.logs[0]!.metadata).toMatchObject({ reason: "opted_out", step: { stepType } });
  });

  it("la baja manda sobre la ventana: fuera de ventana y sin plantilla es una omisión, no un fallo", async () => {
    const t = setup({ optedOut: true, target: { lastInboundAt: hoursAgo(72) } });
    expect(await t.run()).toBe("cancelled");
    expect(t.logs[0]!.status).toBe("skipped_opt_out");
    expect(t.deps.markFailed).not.toHaveBeenCalled();
  });

  it("los pasos que no envían (etiqueta, etapa, condición) no se bloquean: la baja es de mensajes, no del CRM", async () => {
    const t = setup({ optedOut: true, step: { stepType: "add_tag", config: { tagId: "tag_1" } } });
    expect(await t.run()).toBe("completed");
    expect(t.deps.applyTag).toHaveBeenCalled();
    expect(t.deps.isOptedOut).not.toHaveBeenCalled();
    expect(t.logs[0]!.status).toBe("success");
  });

  it("sin baja, todo sigue como siempre", async () => {
    const t = setup();
    expect(await t.run()).toBe("completed");
    expect(t.deps.sendText).toHaveBeenCalledTimes(1);
  });
});

describe("motor — límite de frecuencia (skipped_rate_limit)", () => {
  const full = () => Array.from({ length: AUTOMATION_RATE_LIMIT.maxMessages }, (_, i) => hoursAgo(i + 1));

  it("con el tope alcanzado NO envía: pospone la tarea sin gastar intento y lo registra", async () => {
    const t = setup({ sent: full() });
    expect(await t.run()).toBe("retry");
    expect(t.deps.sendText).not.toHaveBeenCalled();
    // El mensaje más antiguo de la ventana (hace 6 h) sale en 18 h.
    const retryAt = new Date(NOW.getTime() + 18 * 3_600_000);
    expect(t.deps.defer).toHaveBeenCalledWith(t.row, retryAt, "skipped_rate_limit");
    expect(t.deps.reschedule).not.toHaveBeenCalled(); // reschedule SÍ gasta intento
    expect(t.deps.completeAndAdvance).not.toHaveBeenCalled();
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).toMatchObject({ status: "skipped_rate_limit" });
    expect(t.logs[0]!.metadata).toMatchObject({
      used: AUTOMATION_RATE_LIMIT.maxMessages,
      max: AUTOMATION_RATE_LIMIT.maxMessages,
      action: "deferred",
      retryAt: retryAt.toISOString(),
    });
  });

  it("un hueco menos que el tope: envía normal", async () => {
    const t = setup({ sent: full().slice(1) });
    expect(await t.run()).toBe("completed");
    expect(t.deps.sendText).toHaveBeenCalledTimes(1);
    expect(t.deps.defer).not.toHaveBeenCalled();
  });

  it("retenida más de 24 h se DESCARTA: la ejecución termina y se dice en el historial", async () => {
    const t = setup({ sent: full(), row: { createdAt: hoursAgo(25) } });
    expect(await t.run()).toBe("cancelled");
    expect(t.deps.sendText).not.toHaveBeenCalled();
    expect(t.deps.defer).not.toHaveBeenCalled();
    expect(t.deps.markCancelled).toHaveBeenCalledWith(t.row, "skipped_rate_limit");
    expect(t.logs[0]!.metadata).toMatchObject({ action: "discarded" });
  });

  it("no retiene lo que de todos modos fallaría: fuera de ventana sin plantilla falla, no se pospone", async () => {
    const t = setup({ sent: full(), target: { lastInboundAt: hoursAgo(72) } });
    expect(await t.run()).toBe("failed");
    expect(t.deps.defer).not.toHaveBeenCalled();
    expect(t.logs[0]!.status).toBe("failed");
  });

  it("el límite aplica también a send_media (cuenta los envíos de cualquier tipo)", async () => {
    const t = setup({ step: MEDIA_STEP, sent: full() });
    expect(await t.run()).toBe("retry");
    expect(t.deps.sendMedia).not.toHaveBeenCalled();
    expect(t.logs[0]!.status).toBe("skipped_rate_limit");
  });

  it("consulta el historial solo de la ventana de 24 h", async () => {
    const t = setup();
    await t.run();
    expect(t.deps.recentAutomaticSends).toHaveBeenCalledWith("org_1", "ct_1", hoursAgo(24));
  });
});

describe("motor — send_media", () => {
  it("envía el archivo por la vía de las personas, con la leyenda renderizada, y lo registra", async () => {
    const t = setup({ step: MEDIA_STEP });
    expect(await t.run()).toBe("completed");
    expect(t.deps.loadMedia).toHaveBeenCalledWith("org_1", "med_1");
    expect(t.deps.sendMedia).toHaveBeenCalledWith({
      organizationId: "org_1",
      conversationId: "cv_1",
      mediaId: "med_1",
      caption: "Hola Ana, mira esto",
    });
    expect(t.deps.sendText).not.toHaveBeenCalled();
    expect(t.deps.completeAndAdvance).toHaveBeenCalledWith(t.row, NOW);
    expect(t.logs[0]).toMatchObject({ status: "success", queueId: "que_1" });
    expect(t.logs[0]!.metadata).toMatchObject({
      step: { stepType: "send_media", stepName: "Promo" },
      waMessageId: "wamid.msg_media",
      messageId: "msg_media",
      payload: { mode: "media", mediaId: "med_1", mimeType: "image/png", bytes: 9, caption: "Hola Ana, mira esto" },
    });
  });

  it("sin leyenda no manda caption", async () => {
    const t = setup({ step: { stepType: "send_media", config: { mediaId: "med_1" } } });
    expect(await t.run()).toBe("completed");
    expect(t.deps.sendMedia.mock.calls[0]![0]).not.toHaveProperty("caption");
  });

  it("fuera de la ventana de 24 h falla (definitivo) y NO envía ni consulta la biblioteca", async () => {
    const t = setup({ step: MEDIA_STEP, target: { lastInboundAt: hoursAgo(30) } });
    expect(await t.run()).toBe("failed");
    expect(t.deps.sendMedia).not.toHaveBeenCalled();
    expect(t.deps.loadMedia).not.toHaveBeenCalled();
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, OUT_OF_WINDOW_MEDIA_ERROR);
    expect(t.logs[0]).toMatchObject({ status: "failed" });
    // Sin conversación entrante nunca (lastInboundAt null) también está cerrada.
    const never = setup({ step: MEDIA_STEP, target: { lastInboundAt: null } });
    expect(await never.run()).toBe("failed");
  });

  it("un medio borrado falla a la vista con media_not_found; un archivo que falta, con media_file_missing", async () => {
    const gone = setup({ step: MEDIA_STEP, media: { ok: false, reason: "not_found" } });
    expect(await gone.run()).toBe("failed");
    expect(gone.deps.markFailed).toHaveBeenCalledWith(gone.row, "media_not_found");
    expect(gone.deps.sendMedia).not.toHaveBeenCalled();
    const lost = setup({ step: MEDIA_STEP, media: { ok: false, reason: "file_missing" } });
    expect(await lost.run()).toBe("failed");
    expect(lost.deps.markFailed).toHaveBeenCalledWith(lost.row, "media_file_missing");
  });

  it("una configuración inválida falla con invalid_step_config", async () => {
    const t = setup({ step: { stepType: "send_media", config: {} } });
    expect(await t.run()).toBe("failed");
    expect(t.deps.markFailed).toHaveBeenCalledWith(t.row, "invalid_step_config");
  });

  it("idempotente: si un intento anterior ya envió y registró el éxito, no vuelve a enviar", async () => {
    const t = setup({ step: MEDIA_STEP, alreadySucceeded: true });
    expect(await t.run()).toBe("completed");
    expect(t.deps.sendMedia).not.toHaveBeenCalled();
    expect(t.deps.completeAndAdvance).toHaveBeenCalledTimes(1);
  });

  it("el sandbox del Laboratorio y los canales que no son WhatsApp siguen cerrados", async () => {
    const lab = setup({ step: MEDIA_STEP, target: { isTest: true } });
    expect(await lab.run()).toBe("failed");
    expect(lab.deps.sendMedia).not.toHaveBeenCalled();
    const ig = setup({ step: MEDIA_STEP, target: { channel: "instagram" } });
    expect(await ig.run()).toBe("failed");
    expect(ig.deps.sendMedia).not.toHaveBeenCalled();
  });

  it("un fallo de Meta al subir se reintenta como cualquier envío (recuperable)", async () => {
    const t = setup({ step: MEDIA_STEP });
    t.deps.sendMedia.mockRejectedValueOnce(Object.assign(new Error("Meta caída"), { name: "SendError", code: "meta_unavailable" }));
    expect(await t.run()).toBe("retry");
    expect(t.deps.reschedule).toHaveBeenCalled();
    expect(t.logs).toHaveLength(0);
  });
});
