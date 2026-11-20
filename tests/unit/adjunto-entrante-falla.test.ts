import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hallazgo J — cuando la descarga de un adjunto entrante falla, la fila queda `failed` con el número de intento (para la
 * espera creciente del reintento proactivo) o `[gone]` si Meta ya no tiene el archivo (no se reintenta jamás).
 */

const h = vi.hoisted(() => ({
  asset: null as Record<string, unknown> | null,
  sets: [] as Record<string, unknown>[],
  graphRequest: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: () => ({ MEDIA_DIR: "./.no-se-usa", META_GRAPH_BASE_URL: "http://x", META_GRAPH_API_VERSION: "v25.0" }) }));
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (h.asset ? [h.asset] : []) }) }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          h.sets.push(v);
          return Object.assign(Promise.resolve(), { returning: async () => [{ ...h.asset, ...v }] });
        },
      }),
    }),
  }),
  schema: { mediaAsset: { id: "id", organizationId: "organizationId", fileSize: "fileSize", storagePath: "storagePath" } },
}));
vi.mock("@/server/whatsapp/credentials", () => ({ getCredentialsByOrg: async () => ({ token: "t", phoneNumberId: "pn_1", organizationId: "org_1" }) }));
vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest: h.graphRequest };
});

import { MetaApiError } from "@/lib/meta/client";
import { leerFetchError } from "@/lib/media-retry";
import { ensureAssetAvailable } from "@/server/whatsapp/media";

function pendiente(extra: Record<string, unknown> = {}) {
  return { id: "ast_1", organizationId: "org_1", kind: "video", waMediaId: "wa_1", mimeType: "video/mp4", fetchStatus: "pending", fetchError: null, ...extra };
}

beforeEach(() => {
  h.sets = [];
  h.graphRequest.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("ensureAssetAvailable anota la falla", () => {
  it("una falla transitoria deja failed con [intento 1]", async () => {
    h.asset = pendiente();
    h.graphRequest.mockRejectedValue(new MetaApiError("Meta caído", { status: 500 }));
    expect(await ensureAssetAvailable("org_1", "ast_1")).toBeNull();
    const e = h.sets.at(-1)!;
    expect(e.fetchStatus).toBe("failed");
    expect(String(e.fetchError)).toMatch(/^\[intento 1\] /);
    expect(leerFetchError(String(e.fetchError)).gone).toBe(false);
  });

  it("cada falla suma un intento sobre el anterior", async () => {
    h.asset = pendiente({ fetchStatus: "failed", fetchError: "[intento 3] R2 caído" });
    h.graphRequest.mockRejectedValue(new MetaApiError("Meta caído", { status: 500 }));
    await ensureAssetAvailable("org_1", "ast_1");
    expect(String(h.sets.at(-1)!.fetchError)).toMatch(/^\[intento 4\] /);
  });

  it("un texto antiguo sin marca cuenta desde 0 → [intento 1]", async () => {
    h.asset = pendiente({ fetchStatus: "failed", fetchError: "Meta no entregó la metadata del adjunto" });
    h.graphRequest.mockRejectedValue(new MetaApiError("x", { status: 500 }));
    await ensureAssetAvailable("org_1", "ast_1");
    expect(String(h.sets.at(-1)!.fetchError)).toMatch(/^\[intento 1\] /);
  });

  it("si Meta ya no lo tiene (404 en la metadata) queda [gone]: no se reintenta jamás", async () => {
    h.asset = pendiente();
    h.graphRequest.mockRejectedValue(new MetaApiError("no existe", { status: 404 }));
    await ensureAssetAvailable("org_1", "ast_1");
    const e = h.sets.at(-1)!;
    expect(e.fetchStatus).toBe("failed");
    expect(String(e.fetchError)).toMatch(/^\[gone\] /);
    expect(leerFetchError(String(e.fetchError)).gone).toBe(true);
  });

  it("un adjunto que excede el límite también es permanente ([gone])", async () => {
    h.asset = pendiente();
    h.graphRequest.mockResolvedValue({ url: "https://meta.example/x", file_size: 900 * 1024 * 1024 });
    await ensureAssetAvailable("org_1", "ast_1");
    expect(String(h.sets.at(-1)!.fetchError)).toMatch(/^\[gone\] /);
  });

  it("lo ya disponible no se toca", async () => {
    h.asset = pendiente({ fetchStatus: "available" });
    expect(await ensureAssetAvailable("org_1", "ast_1")).toMatchObject({ fetchStatus: "available" });
    expect(h.sets).toHaveLength(0);
    expect(h.graphRequest).not.toHaveBeenCalled();
  });
});
