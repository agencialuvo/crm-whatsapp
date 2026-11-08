import { describe, expect, it } from "vitest";
import {
  LOG_FILTERS,
  MAX_LOG_ROWS,
  describeLog,
  explainError,
  formatWhen,
  logStatusLabel,
  logStatusTone,
  logStepTitle,
  prettyJson,
  relativeWhen,
  type LogDto,
} from "@/lib/automation-monitor-dto";
import { LOG_STATUS_FILTERS } from "@/lib/automation-schemas";

/**
 * Automatizaciones (pantallas de monitoreo) — los textos y la lectura de `metadata`. Sin React: la
 * interacción (filtros, paginación, diálogo) se comprueba en el navegador.
 */

const log = (over: Partial<LogDto> = {}): LogDto => ({
  id: "log_1",
  flowId: "flw_1",
  flowName: "Cumple",
  step: { id: "stp_1", stepType: "send_whatsapp" },
  queueId: "que_1",
  status: "success",
  contact: { id: "ct_1", name: "Ana", phone: "5215550001" },
  error: null,
  metadata: null,
  executedAt: "2026-11-08T16:48:00.000Z",
  ...over,
});

describe("filtros del historial", () => {
  it("cada pestaña es un filtro que acepta la API (o «todos»)", () => {
    for (const f of LOG_FILTERS) {
      expect(f.value === "all" || (LOG_STATUS_FILTERS as readonly string[]).includes(f.value)).toBe(true);
    }
    expect(LOG_FILTERS.map((f) => f.label)).toEqual(["Todos", "Exitosos", "Fallidos", "Omitidos"]);
  });
  it("«Todos» las filas pide como máximo lo que el servidor entrega", () => {
    expect(MAX_LOG_ROWS).toBe(100);
  });
});

describe("estados", () => {
  it("etiquetas en español y un estado desconocido tal cual", () => {
    expect(logStatusLabel("success")).toBe("Enviado");
    expect(logStatusLabel("failed")).toBe("Fallido");
    expect(logStatusLabel("skipped_rate_limit")).toContain("frecuencia");
    expect(logStatusLabel("skipped_opt_out")).toContain("baja");
    expect(logStatusLabel("raro")).toBe("raro");
  });
  it("color por estado: éxito verde, fallo rojo, omitido ámbar", () => {
    expect(logStatusTone("success")).toBe("success");
    expect(logStatusTone("failed")).toBe("destructive");
    expect(logStatusTone("skipped_opt_out")).toBe("warning");
    expect(logStatusTone("skipped_rate_limit")).toBe("warning");
    expect(logStatusTone("raro")).toBe("secondary");
  });
});

describe("explainError", () => {
  it("explica los errores conocidos aunque lleven texto alrededor", () => {
    expect(explainError("out_of_window_requires_template")).toContain("24 h");
    expect(explainError("max_attempts_exceeded: meta: 500")).toContain("reintentos");
    expect(explainError("no_conversation")).toContain("conversación");
    expect(explainError("sandbox_conversation")).toContain("prueba");
  });
  it("un error desconocido o ausente no inventa explicación", () => {
    expect(explainError("algo_nuevo")).toBeNull();
    expect(explainError(null)).toBeNull();
    expect(explainError("")).toBeNull();
  });
});

describe("logStepTitle", () => {
  it("usa el nombre de la foto del paso, aunque el paso ya no exista", () => {
    const md = { step: { stepType: "send_whatsapp", stepName: "Saludo de cumple", config: {} } };
    expect(logStepTitle({ step: null, metadata: md })).toBe("Saludo de cumple");
  });
  it("sin nombre usa el del tipo; sin nada, «Paso eliminado»", () => {
    expect(logStepTitle({ step: { id: "s", stepType: "delay" }, metadata: null })).toBe("Esperar");
    expect(logStepTitle({ step: null, metadata: { step: { stepType: "send_whatsapp" } } })).toBe(
      "Enviar mensaje de WhatsApp"
    );
    expect(logStepTitle({ step: null, metadata: null })).toBe("Paso eliminado");
  });
});

describe("describeLog", () => {
  it("un envío exitoso: IDs de WhatsApp y del CRM, ventana y payload", () => {
    const d = describeLog(
      log({
        metadata: {
          attempt: 1,
          step: { stepType: "send_whatsapp", stepName: "Saludo", config: { content: "Hola" } },
          windowOpen: true,
          waMessageId: "wamid.ABC",
          messageId: "msg_9",
          payload: { type: "text", text: { body: "Hola" } },
        },
      })
    );
    expect(d).toMatchObject({
      title: "Saludo",
      stepExists: true,
      stepType: "send_whatsapp",
      attempt: 1,
      error: null,
      waMessageId: "wamid.ABC",
      messageId: "msg_9",
      windowOpen: true,
      payload: { type: "text", text: { body: "Hola" } },
      stepConfig: { content: "Hola" },
    });
  });
  it("un fallo: el mensaje exacto y su explicación; sin payload", () => {
    const d = describeLog(log({ status: "failed", error: "out_of_window_requires_template", metadata: { error: "out_of_window_requires_template" } }));
    expect(d.error).toBe("out_of_window_requires_template");
    expect(d.errorHint).toContain("plantilla");
    expect(d.payload).toBeNull();
    expect(d.waMessageId).toBeNull();
  });
  it("el error sale de metadata si la línea no lo trae aparte", () => {
    expect(describeLog(log({ status: "failed", metadata: { error: "boom" } })).error).toBe("boom");
  });
  it("un omitido explica el motivo", () => {
    expect(describeLog(log({ status: "skipped_opt_out" })).skipReason).toContain("no recibir");
    expect(describeLog(log({ status: "skipped_rate_limit" })).skipReason).toContain("frecuencia");
    expect(describeLog(log({ status: "success" })).skipReason).toBeNull();
  });
  it("un paso de espera guarda cuándo sigue el siguiente", () => {
    const d = describeLog(log({ metadata: { step: { stepType: "delay" }, nextAt: "2026-11-09T10:00:00.000Z" } }));
    expect(d.nextAt).toBe("2026-11-09T10:00:00.000Z");
  });
  it("sin metadata ni paso no revienta", () => {
    const d = describeLog(log({ step: null, metadata: null }));
    expect(d).toMatchObject({ title: "Paso eliminado", stepExists: false, raw: null, attempt: null, payload: null });
  });
  it("metadata con formas inesperadas se ignora sin lanzar", () => {
    const d = describeLog(log({ metadata: { step: "texto", attempt: "2", waMessageId: 5, windowOpen: "sí" } }));
    expect(d).toMatchObject({ attempt: null, waMessageId: null, windowOpen: null, stepConfig: null });
  });
});

describe("fechas", () => {
  it("formatWhen: una fecha legible, y guion si falta o es inválida", () => {
    expect(formatWhen("2026-11-08T16:48:00.000Z")).toMatch(/2026/);
    expect(formatWhen(null)).toBe("—");
    expect(formatWhen("no es fecha")).toBe("—");
  });
  it("relativeWhen: futuro y pasado", () => {
    const now = Date.parse("2026-11-08T12:00:00Z");
    expect(relativeWhen("2026-11-08T12:05:00Z", now)).toBe("en 5 min");
    expect(relativeWhen("2026-11-08T10:00:00Z", now)).toBe("hace 2 h");
    expect(relativeWhen("2026-11-06T12:00:00Z", now)).toBe("hace 2 d");
    expect(relativeWhen("2026-11-08T12:00:10Z", now)).toBe("en menos de 1 min");
    expect(relativeWhen(null, now)).toBe("—");
  });
});

describe("prettyJson", () => {
  it("con sangría, y no lanza con referencias circulares", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    const c: Record<string, unknown> = {};
    c.self = c;
    expect(() => prettyJson(c)).not.toThrow();
  });
});
