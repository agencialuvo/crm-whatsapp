import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El token de WhatsApp solo viaja a hosts de Meta. La URL de descarga llega en la respuesta de la Graph API; si no
 * es de Meta (o apunta a la red interna), `downloadGraphMedia` y `streamGraphMediaToR2` fallan SIN hacer la petición.
 */

const graphRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/meta/client", () => ({
  graphRequest,
  MetaApiError: class MetaApiError extends Error {
    status = 0;
  },
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}), schema: {} }));
vi.mock("@/server/whatsapp/credentials", () => ({ getCredentialsByOrg: async () => null }));
const signUpload = vi.hoisted(() => vi.fn());
vi.mock("@/server/storage", () => ({
  claveDeMedio: () => "k",
  objectStore: () => ({ signUpload }),
}));

const TOKEN = "EAAG-token-secreto";
const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  graphRequest.mockReset();
  signUpload.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("WA_MOCK_ENABLED", "");
  vi.stubEnv("META_GRAPH_BASE_URL", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const meta = (url: string) => ({ url, mime_type: "image/jpeg", file_size: 1000 });

const MALAS = [
  "https://evil.example.com/media.jpg",
  "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  "http://localhost:3000/api/secret",
  "http://lookaside.fbsbx.com/x", // sin TLS
  "https://fbsbx.com.evil.com/x",
];

describe("downloadGraphMedia", () => {
  it.each(MALAS)("no manda el token a %s", async (url) => {
    const { downloadGraphMedia, MediaFetchError } = await import("@/server/whatsapp/media");
    graphRequest.mockResolvedValue(meta(url));
    const err = await downloadGraphMedia(TOKEN, "media1").catch((e) => e);
    expect(err).toBeInstanceOf(MediaFetchError);
    expect(err.gone).toBe(true); // permanente: no se reintenta
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("con un host de Meta sí descarga, con el Bearer", async () => {
    const { downloadGraphMedia } = await import("@/server/whatsapp/media");
    graphRequest.mockResolvedValue(meta("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1"));
    fetchSpy.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } }));
    const r = await downloadGraphMedia(TOKEN, "media1");
    expect(r.fileSize).toBe(3);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("lookaside.fbsbx.com");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
  });

  it("el origen del wa-mock solo se acepta con los mocks habilitados", async () => {
    const { downloadGraphMedia, MediaFetchError } = await import("@/server/whatsapp/media");
    const url = "http://localhost:3000/api/dev/wa-mock/media-file/media1";
    graphRequest.mockResolvedValue(meta(url));
    fetchSpy.mockResolvedValue(new Response(new Uint8Array([9]), { status: 200 }));

    // sin mocks: rechazado aunque META_GRAPH_BASE_URL apunte ahí
    vi.stubEnv("META_GRAPH_BASE_URL", "http://localhost:3000/api/dev/wa-mock/graph");
    await expect(downloadGraphMedia(TOKEN, "media1")).rejects.toBeInstanceOf(MediaFetchError);
    expect(fetchSpy).not.toHaveBeenCalled();

    // con mocks (y fuera de producción): permitido
    vi.stubEnv("WA_MOCK_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "test");
    const r = await downloadGraphMedia(TOKEN, "media1");
    expect(r.fileSize).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // en producción los mocks no existen aunque la variable esté puesta
    fetchSpy.mockClear();
    vi.stubEnv("NODE_ENV", "production");
    await expect(downloadGraphMedia(TOKEN, "media1")).rejects.toBeInstanceOf(MediaFetchError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("streamGraphMediaToR2", () => {
  it.each(MALAS)("tampoco manda el token a %s", async (url) => {
    const { streamGraphMediaToR2, MediaFetchError } = await import("@/server/whatsapp/media");
    graphRequest.mockResolvedValue(meta(url));
    const err = await streamGraphMediaToR2(TOKEN, "media1", "clave", null).catch((e) => e);
    expect(err).toBeInstanceOf(MediaFetchError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(signUpload).not.toHaveBeenCalled();
  });
});
