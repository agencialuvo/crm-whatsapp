import { beforeEach, describe, expect, it, vi } from "vitest";
import { nombreDeEnvio, resolverEnvio, type ItemParaEnvio } from "@/server/medios/envio";
import { explainError } from "@/lib/automation-monitor-dto";

/**
 * Medios — Paso 3a: QUÉ se manda por WhatsApp (`resolverEnvio`), cómo lo usa `sendLibraryMedia` y cómo se explican los
 * errores. Sin base de datos: la caché y el motor con Postgres están en `medios-envio-live.test.ts`.
 */

const MB = 1024 * 1024;

const base: ItemParaEnvio = {
  kind: "video",
  mimeType: "video/mp4",
  sizeBytes: 5 * MB,
  variantStatus: "none",
  variantMimeType: null,
  variantSizeBytes: null,
  variantStorageKey: null,
  variantError: null,
};
const video = (o: Partial<ItemParaEnvio> = {}): ItemParaEnvio => ({ ...base, ...o });
const lista = { variantStatus: "ready" as const, variantMimeType: "video/mp4", variantSizeBytes: 9 * MB, variantStorageKey: "org/o/medios-wa/m" };

describe("resolverEnvio — imágenes y PDF (como siempre)", () => {
  it("una imagen enviable sale tal cual", () => {
    expect(resolverEnvio(video({ kind: "image", mimeType: "image/png", sizeBytes: 1 * MB }))).toEqual({ ok: true, fuente: "original", mimeType: "image/png", sizeBytes: 1 * MB });
  });
  it("un PDF sale tal cual", () => {
    expect(resolverEnvio(video({ kind: "document", mimeType: "application/pdf", sizeBytes: 3 * MB }))).toMatchObject({ ok: true, fuente: "original" });
  });
  it("AVIF no se envía: unsupported", () => {
    expect(resolverEnvio(video({ kind: "image", mimeType: "image/avif", sizeBytes: 1 * MB }))).toEqual({ ok: false, razon: "unsupported" });
  });
});

describe("resolverEnvio — video", () => {
  it("none con un MP4 de 16 MiB o menos: el original (videos de siempre y caso A)", () => {
    expect(resolverEnvio(video({ sizeBytes: 16 * MB }))).toEqual({ ok: true, fuente: "original", mimeType: "video/mp4", sizeBytes: 16 * MB });
  });

  it("none con un MP4 de más de 16 MiB: too_large; con un MOV: unsupported", () => {
    expect(resolverEnvio(video({ sizeBytes: 40 * MB }))).toEqual({ ok: false, razon: "too_large" });
    expect(resolverEnvio(video({ mimeType: "video/quicktime", sizeBytes: 40 * MB }))).toEqual({ ok: false, razon: "unsupported" });
    expect(resolverEnvio(video({ mimeType: "video/quicktime", sizeBytes: 2 * MB }))).toEqual({ ok: false, razon: "unsupported" });
  });

  it("ready: la VARIANTE, con su MIME y su peso (no los del original)", () => {
    expect(resolverEnvio(video({ ...lista, mimeType: "video/quicktime", sizeBytes: 200 * MB }))).toEqual({ ok: true, fuente: "variante", mimeType: "video/mp4", sizeBytes: 9 * MB });
  });

  it("ready gana aunque el original también fuese enviable", () => {
    expect(resolverEnvio(video({ ...lista, sizeBytes: 5 * MB }))).toMatchObject({ ok: true, fuente: "variante", sizeBytes: 9 * MB });
  });

  it("ready con datos incompletos: variant_failed, nunca un envío a ciegas", () => {
    for (const roto of [{ variantMimeType: null }, { variantSizeBytes: null }, { variantSizeBytes: 0 }, { variantStorageKey: null }]) {
      const e = resolverEnvio(video({ ...lista, ...roto }));
      expect(e, JSON.stringify(roto)).toMatchObject({ ok: false, razon: "variant_failed" });
    }
  });

  it("processing con el original grande: processing (todavía no se puede)", () => {
    expect(resolverEnvio(video({ variantStatus: "processing", sizeBytes: 100 * MB }))).toEqual({ ok: false, razon: "processing" });
    expect(resolverEnvio(video({ variantStatus: "processing", mimeType: "video/quicktime", sizeBytes: 3 * MB }))).toEqual({ ok: false, razon: "processing" });
  });

  it("processing con un original que YA se puede enviar: se envía el original (no se frena un envío posible)", () => {
    expect(resolverEnvio(video({ variantStatus: "processing", sizeBytes: 8 * MB }))).toMatchObject({ ok: true, fuente: "original" });
  });

  it("failed con el original enviable: el original; sin poder enviarlo: variant_failed con el motivo", () => {
    expect(resolverEnvio(video({ variantStatus: "failed", variantError: "x", sizeBytes: 8 * MB }))).toMatchObject({ ok: true, fuente: "original" });
    expect(resolverEnvio(video({ variantStatus: "failed", variantError: "El video dura más de 3 minutos", sizeBytes: 80 * MB }))).toEqual({
      ok: false,
      razon: "variant_failed",
      detalle: "El video dura más de 3 minutos",
    });
    expect(resolverEnvio(video({ variantStatus: "failed", variantError: null, sizeBytes: 80 * MB }))).toEqual({ ok: false, razon: "variant_failed", detalle: undefined });
  });
});

describe("nombreDeEnvio", () => {
  it("la extensión sale del MIME que se envía (la variante es .mp4 aunque el original sea MOV)", () => {
    expect(nombreDeEnvio("promo", "video/mp4")).toBe("promo.mp4");
    expect(nombreDeEnvio("foto", "image/jpeg")).toBe("foto.jpg");
    expect(nombreDeEnvio("carta", "application/pdf")).toBe("carta.pdf");
    expect(nombreDeEnvio("raro", "x")).toBe("raro");
  });
});

describe("explicaciones de error (Paso 3a)", () => {
  it.each([
    ["media_variant_pending", /preparando para WhatsApp/],
    ["media_variant_failed: El video dura más de 3 minutos", /No se pudo preparar el video/],
    ["media_too_large", /16 MB.*optimiz/],
    ["media_unsupported_format", /MOV|MP4/],
  ])("%s tiene una explicación legible", (codigo, re) => {
    expect(explainError(codigo)).toMatch(re);
  });
});

/* ---------- sendLibraryMedia con la fuente resuelta (sin red ni base) ---------- */

const h = vi.hoisted(() => ({
  filas: [] as unknown[][],
  asset: null as Record<string, unknown> | null,
  graph: [] as Record<string, unknown>[],
  resolve: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const cadena = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "where", "orderBy"]) c[m] = () => c;
    c.limit = () => Promise.resolve(rows);
    return c;
  };
  return {
    getDb: () => ({
      select: () => cadena(h.filas.shift() ?? []),
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          returning: async () => {
            h.asset = { ...v };
            return [h.asset];
          },
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    }),
    schema: {
      conversation: { contactId: "contactId", id: "id" },
      contact: { id: "id" },
      message: {},
      mediaAsset: { id: "id" },
      mediaLibraryItem: { organizationId: "o", id: "i", status: "s" },
    },
  };
});
vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest: vi.fn(async (_p: string, o: { body: Record<string, unknown> }) => (h.graph.push(o.body), { messages: [{ id: "wamid.1" }] })) };
});
vi.mock("@/server/whatsapp/credentials", () => ({
  getCredentialsByOrg: async () => ({ organizationId: "org_1", phoneNumberId: "pn_1", token: "t", status: "connected" }),
}));
vi.mock("@/server/whatsapp/media-cache", () => ({
  resolveWaMediaId: (...a: unknown[]) => h.resolve(...a),
  invalidateWaMediaId: vi.fn(),
  MediaArchivoAusente: class extends Error {},
}));
vi.mock("@/server/inbox/outbox", () => ({
  enviarYRegistrar: async (i: { enviar: () => Promise<string>; fila: { media: unknown; type: string } }) => {
    const waId = await i.enviar();
    return { messageId: "msg_1", waMessageId: waId, media: i.fila.media, type: i.fila.type };
  },
}));

const conv = (extra = {}) => [
  {
    conversation: { id: "cv_1", organizationId: "org_1", isTest: false, channel: "whatsapp", lastInboundAt: new Date() },
    contact: { id: "ct_1", phone: "5215511111111", waUserId: null, waIdentity: "5215511111111" },
    ...extra,
  },
];
const item = (o: Partial<ItemParaEnvio> & Record<string, unknown> = {}) => ({ id: "med_1", organizationId: "org_1", name: "promo", status: "ready", ...base, ...o });

describe("sendLibraryMedia con el Paso 3a", () => {
  beforeEach(() => {
    h.filas.length = 0;
    h.asset = null;
    h.graph.length = 0;
    h.resolve.mockReset();
    h.resolve.mockResolvedValue({ waMediaId: "wa_media_1", reused: false });
  });

  async function enviar() {
    const { sendLibraryMedia } = await import("@/server/inbox/send");
    return sendLibraryMedia({ conversationId: "cv_1", organizationId: "org_1", mediaId: "med_1", caption: "hola" });
  }

  it("variante lista: el adjunto y el mensaje a Meta llevan el MIME, el peso y el nombre de la VARIANTE", async () => {
    h.filas.push([item({ ...lista, mimeType: "video/quicktime", sizeBytes: 120 * MB })], conv());
    await enviar();
    expect(h.asset).toMatchObject({ kind: "video", mimeType: "video/mp4", fileSize: 9 * MB, fileName: "promo.mp4", libraryItemId: "med_1" });
    expect(h.graph[0]).toMatchObject({ type: "video", video: { id: "wa_media_1", caption: "hola" } });
  });

  it("sin variante y con el original enviable: el original, como siempre", async () => {
    h.filas.push([item({ sizeBytes: 5 * MB })], conv());
    await enviar();
    expect(h.asset).toMatchObject({ mimeType: "video/mp4", fileSize: 5 * MB, fileName: "promo.mp4" });
  });

  it("video en processing sin original enviable: error claro y NO toca la conversación, la caché ni Meta", async () => {
    h.filas.push([item({ variantStatus: "processing", sizeBytes: 90 * MB })], conv());
    await expect(enviar()).rejects.toMatchObject({ code: "meta_error", message: expect.stringContaining("preparando para WhatsApp") });
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.graph).toHaveLength(0);
    expect(h.asset).toBeNull();
  });

  it("video fallido sin original enviable: el error lleva el motivo", async () => {
    h.filas.push([item({ variantStatus: "failed", variantError: "No se pudo leer el video", sizeBytes: 90 * MB })], conv());
    await expect(enviar()).rejects.toMatchObject({ message: expect.stringContaining("No se pudo leer el video") });
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("MP4 grande sin variante: too_large legible; MOV: no se puede enviar", async () => {
    h.filas.push([item({ sizeBytes: 90 * MB })]);
    await expect(enviar()).rejects.toMatchObject({ message: expect.stringContaining("más de 16 MB") });
    h.filas.push([item({ mimeType: "video/quicktime", sizeBytes: 3 * MB })]);
    await expect(enviar()).rejects.toMatchObject({ message: expect.stringContaining("no se puede enviar") });
  });
});
