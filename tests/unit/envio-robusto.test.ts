import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 041 — Lo que se puede afirmar sin base de datos: el tiempo máximo de Graph y su ambigüedad,
 * la traducción a SendError y los reintentos al guardar el id. Lo demás (la carrera del estado
 * temprano, los fallos por tipo, la barredera) está en `envio-robusto-live.test.ts`.
 */

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ META_GRAPH_BASE_URL: "http://graph.test", META_GRAPH_API_VERSION: "v99.0" }),
}));

const graphRequest = vi.fn();
vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest };
});

const real = await vi.importActual<typeof import("@/lib/meta/client")>("@/lib/meta/client");
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  graphRequest.mockReset();
});

/** Un fetch que no responde nunca, pero respeta la señal de aborto como el de verdad. */
function fetchColgado(): typeof fetch {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
}

describe("tiempo máximo de la Graph API", () => {
  it("un POST que no responde se corta y se marca AMBIGUO: Meta pudo haber aceptado el mensaje", async () => {
    vi.stubEnv("META_GRAPH_TIMEOUT_MS", "40");
    globalThis.fetch = fetchColgado();
    const err = await real
      .graphRequest("pn/messages", { method: "POST", token: "t", body: {} })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(real.MetaApiError);
    const e = err as InstanceType<typeof real.MetaApiError>;
    expect(e.ambiguous).toBe(true);
    expect(e.status).toBe(0);
    expect(e.message).toMatch(/pudo haber salido/);
  });

  it("un error de conexión NO es ambiguo: seguro no salió nada", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    const e = (await real
      .graphRequest("pn/messages", { method: "POST", token: "t", body: {} })
      .then(() => null, (x: unknown) => x)) as InstanceType<typeof real.MetaApiError>;
    expect(e.ambiguous).toBe(false);
    expect(e.message).toBe("No se pudo contactar la API de Meta");
  });

  it("un rechazo de Meta tampoco es ambiguo", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "no", code: 131000 } }), { status: 400 })) as typeof fetch;
    const e = (await real
      .graphRequest("pn/messages", { method: "POST", token: "t", body: {} })
      .then(() => null, (x: unknown) => x)) as InstanceType<typeof real.MetaApiError>;
    expect(e.ambiguous).toBe(false);
    expect(e.status).toBe(400);
  });

  it("las lecturas esperan el doble que los envíos", async () => {
    // Con 40 ms para enviar, una lectura de 60 ms no se corta (tope de 80).
    vi.stubEnv("META_GRAPH_TIMEOUT_MS", "40");
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 60));
      init?.signal?.throwIfAborted();
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await expect(real.graphRequest("act_1/ads", { token: "t" })).resolves.toEqual({});
  });
});

describe("callGraphSend traduce el tiempo agotado", () => {
  it("lo deja como meta_unavailable con el aviso de ambigüedad, no con el genérico", async () => {
    const { callGraphSend } = await import("@/server/inbox/send");
    const { SendError } = await import("@/server/inbox/send-error");
    graphRequest.mockRejectedValueOnce(
      new real.MetaApiError("Meta no respondió a tiempo: el mensaje pudo haber salido", {
        status: 0,
        ambiguous: true,
      })
    );
    const err = await callGraphSend(
      { organizationId: "o", phoneNumberId: "p", wabaId: "w", token: "t", status: "connected" } as never,
      {}
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect((err as InstanceType<typeof SendError>).code).toBe("meta_unavailable");
    expect((err as Error).message).toMatch(/pudo haber salido/);

    graphRequest.mockRejectedValueOnce(new real.MetaApiError("x", { status: 503 }));
    const generico = await callGraphSend({ organizationId: "o", phoneNumberId: "p", token: "t" } as never, {}).then(
      () => null,
      (e: unknown) => e
    );
    expect((generico as Error).message).toBe("Meta no está disponible ahora");
  });
});

describe("confirmarEnvio: reintentos al guardar el id", () => {
  const fila = { id: "msg_x", organizationId: "org_x", conversationId: "cv_x" };

  it("reintenta y termina bien si la base se recupera", async () => {
    const { confirmarEnvio } = await import("@/server/inbox/outbox");
    let n = 0;
    const ok = await confirmarEnvio(fila, "wamid.A", "sent", {
      esperas: [0, 0, 0],
      guardarId: async () => {
        if (++n < 3) throw new Error("base caída");
        return true;
      },
    });
    expect(ok).toBe(true);
    expect(n).toBe(3);
  });

  it("agotados los intentos NO lanza (el mensaje ya salió) y deja el id de Meta en el log", async () => {
    const { confirmarEnvio } = await import("@/server/inbox/outbox");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = await confirmarEnvio(fila, "wamid.PERDIDO", "sent", {
      esperas: [0, 0, 0],
      guardarId: async () => {
        throw new Error("base caída");
      },
    });
    expect(ok).toBe(false);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("wamid.PERDIDO"))).toBe(true);
    spy.mockRestore();
  });
});

describe("códigos de envío", () => {
  it("el mapa compartido cubre todos los códigos de SendError", async () => {
    const { SEND_ERROR_STATUS } = await import("@/server/inbox/send-status");
    for (const code of [
      "sandbox_violation",
      "not_connected",
      "reconnect_required",
      "window_closed",
      "message_limit",
      "text_too_long",
      "meta_error",
      "meta_unavailable",
      "upload_failed",
    ] as const) {
      expect(SEND_ERROR_STATUS[code], code).toBeGreaterThanOrEqual(400);
    }
  });
});
