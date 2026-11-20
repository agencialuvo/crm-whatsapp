import { describe, expect, it, vi } from "vitest";
import { CACHE_TTL_DAYS, cacheExpiry, decideMediaSource, esLease, isStaleMediaError, LEASE_MS, leaseId, STALE_MEDIA_RULES, StaleMediaRetry, withStaleMediaRetry, type CachedMedia } from "@/lib/media-cache";
import { esEnviablePorWhatsapp, MAX_VIDEO_BYTES } from "@/lib/medios";
import { claveDeMedio, clavePendiente } from "@/server/storage/keys";
import { detectarFormato, revisarCodecsMp4 } from "@/server/medios/sniff";

/** 048 — Reglas puras: cuándo reutilizar el media_id de WhatsApp, cuándo reintentar, claves y reconocimiento de PDF/MP4. */

const NOW = new Date("2026-11-18T12:00:00Z");
const DAY = 86_400_000;
const item = { mimeType: "image/png", sizeBytes: 1000 };
const cache = (over: Partial<CachedMedia> = {}): CachedMedia => ({
  phoneNumberId: "pn_1",
  waMediaId: "wa_media_1",
  mimeType: "image/png",
  sizeBytes: 1000,
  expiresAt: new Date(NOW.getTime() + DAY),
  ...over,
});

describe("decideMediaSource", () => {
  it("vigente, mismo número y mismo medio → reutiliza (0 bytes)", () => {
    expect(decideMediaSource(cache(), item, "pn_1", NOW)).toEqual({ action: "reuse", waMediaId: "wa_media_1" });
  });
  it("sin fila → sube", () => {
    expect(decideMediaSource(null, item, "pn_1", NOW)).toEqual({ action: "upload", reason: "none" });
  });
  it("vencida (incluso por 1 ms o justo ahora) → sube", () => {
    expect(decideMediaSource(cache({ expiresAt: new Date(NOW.getTime() - 1) }), item, "pn_1", NOW)).toMatchObject({ reason: "expired" });
    expect(decideMediaSource(cache({ expiresAt: NOW }), item, "pn_1", NOW)).toMatchObject({ reason: "expired" });
    expect(decideMediaSource(cache({ expiresAt: new Date(NOW.getTime() + 1) }), item, "pn_1", NOW).action).toBe("reuse");
  });
  it("un media_id es de UN número: otro phone_number_id no lo reutiliza", () => {
    expect(decideMediaSource(cache(), item, "pn_2", NOW)).toEqual({ action: "upload", reason: "other_phone" });
  });
  it("si el medio cambió (tipo o peso) no se reutiliza", () => {
    expect(decideMediaSource(cache(), { ...item, sizeBytes: 1001 }, "pn_1", NOW)).toMatchObject({ reason: "changed" });
    expect(decideMediaSource(cache(), { ...item, mimeType: "image/jpeg" }, "pn_1", NOW)).toMatchObject({ reason: "changed" });
  });
  it("vence a los 25 días, con 5 de margen sobre los 30 de Meta", () => {
    expect(CACHE_TTL_DAYS).toBe(25);
    expect(cacheExpiry(NOW).getTime() - NOW.getTime()).toBe(25 * DAY);
  });
});

describe("isStaleMediaError (el reintento único)", () => {
  it.each([
    [{ code: 131052 }, true],
    [{ code: 131053 }, true],
    // 131047 = ventana de 24 h cerrada: NO es un media vencido (invalidar la caché y re-subir fallaría igual).
    [{ code: 131047 }, false],
    [{ code: 131047, message: "Re-engagement message: media id" }, false],
    [{ code: 131009, message: "Parameter value is not valid: media id not found" }, true],
    [{ code: 131009, details: { error: { error_data: { details: "Media ID is not valid" } } } }, true],
    [{ code: 131009, details: { error: { error_user_msg: "El media no existe" } } }, true],
    [{ code: 131009, message: "Parameter value is not valid" }, false],
    [{ code: 131009, message: "Parameter value is not valid: phone number" }, false],
    [{ code: 100, details: { error: { error_data: { details: "Media ID 123 does not exist" } } } }, true],
    [{ code: 100, message: "Invalid parameter: media id does not exist" }, true],
    [{ code: 190, details: { error: { error_subcode: 1357004 } } }, true],
    [{ code: 190, details: { error: { error_subcode: 2018047 } } }, true],
    [{ code: 190, details: { error: { error_subcode: 123 } } }, false],
    [{ code: 100, message: "Invalid parameter: to" }, false],
    [{ code: 190 }, false],
    [{ code: 131026 }, false],
    [null, false],
  ])("%j → %s", (err, esperado) => expect(isStaleMediaError(err as never)).toBe(esperado));
});

describe("arrendamiento de subida en curso (Hallazgo G)", () => {
  it("un marcador pending:<token> vigente NO se reutiliza como media_id: hay que esperar", () => {
    expect(decideMediaSource(cache({ waMediaId: leaseId("abc"), expiresAt: new Date(NOW.getTime() + LEASE_MS) }), item, "pn_1", NOW)).toEqual({
      action: "upload",
      reason: "in_progress",
    });
  });
  it("vencido, el marcador es una subida abandonada: se retoma", () => {
    expect(decideMediaSource(cache({ waMediaId: leaseId("abc"), expiresAt: new Date(NOW.getTime() - 1) }), item, "pn_1", NOW)).toMatchObject({ reason: "expired" });
  });
  it("reconoce los marcadores y no confunde un media_id real", () => {
    expect(esLease(leaseId("x"))).toBe(true);
    expect(esLease("1234567890")).toBe(false);
    expect(LEASE_MS).toBe(2 * 60 * 1000);
  });
});

describe("STALE_MEDIA_RULES (la constante que se ajusta al probar con un número real)", () => {
  it("131047 no está en ninguna regla", () => {
    expect(STALE_MEDIA_RULES.codes).not.toContain(131047);
    expect(STALE_MEDIA_RULES.generic.map((g) => g.code)).not.toContain(131047);
    expect(STALE_MEDIA_RULES.subcodes).not.toContain(131047);
  });
  it("los códigos de media bastan por sí solos; los genéricos (100, 131009) necesitan que el texto hable del media", () => {
    expect([...STALE_MEDIA_RULES.codes]).toEqual([131052, 131053]);
    expect([...STALE_MEDIA_RULES.subcodes]).toEqual([1357004, 2018047]);
    expect(STALE_MEDIA_RULES.generic.map((g) => g.code)).toEqual([100, 131009]);
    for (const code of [100, 131009]) expect(isStaleMediaError({ code })).toBe(false);
  });
});

describe("lo enviable por WhatsApp", () => {
  it("AVIF y un video de más de 16 MB no se envían; PDF, imágenes y MP4 sí", () => {
    expect(esEnviablePorWhatsapp("image/avif", 1000)).toBe(false);
    expect(esEnviablePorWhatsapp("video/mp4", MAX_VIDEO_BYTES + 1)).toBe(false);
    expect(esEnviablePorWhatsapp("video/mp4", MAX_VIDEO_BYTES)).toBe(true);
    expect(esEnviablePorWhatsapp("application/pdf", 1000)).toBe(true);
    expect(esEnviablePorWhatsapp("image/png", 1000)).toBe(true);
  });
});

describe("claves de objeto", () => {
  it("por organización, y un segmento raro no pasa", () => {
    expect(claveDeMedio("org_1", "med_a")).toBe("org/org_1/medios/med_a");
    expect(clavePendiente("org_1", "med_a")).toBe("pending/org_1/med_a");
    expect(() => claveDeMedio("../x", "med_a")).toThrow();
    expect(() => claveDeMedio("org_1", "a/b")).toThrow();
  });
});

describe("reconocimiento por bytes", () => {
  const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  it("un PDF se reconoce por %PDF-", () => {
    expect(detectarFormato(ascii("%PDF-1.7\nxxxx"))).toMatchObject({ ext: "pdf", tipo: "document" });
    expect(detectarFormato(ascii("<html>%PDF-"))).toBeNull();
  });
  it("aviso de códec: sin avc1 avisa; con avc1 no", () => {
    expect(revisarCodecsMp4(ascii("....ftypisom....hev1...."))).toMatch(/H\.264/);
    expect(revisarCodecsMp4(ascii("....ftypisom....avc1....mp4a"))).toBeNull();
  });
});

describe("withStaleMediaRetry (a lo sumo UN reintento)", () => {
  it("el reintento recibe el id que Meta rechazó, para no reutilizarlo", async () => {
    const run = vi.fn(async (force: boolean) => {
      if (!force) throw new StaleMediaRetry("OLD-ID");
      return "ok";
    });
    expect(await withStaleMediaRetry(run)).toBe("ok");
    expect(run.mock.calls).toEqual([[false], [true, "OLD-ID"]]);
  });

  it("sin error corre una vez y sin forzar", async () => {
    const run = vi.fn(async () => "ok");
    expect(await withStaleMediaRetry(run)).toBe("ok");
    expect(run.mock.calls).toEqual([[false]]);
  });
  it("si Meta rechazó el id reutilizado, sube de nuevo y reintenta una vez", async () => {
    const run = vi.fn(async (force: boolean) => {
      if (!force) throw new StaleMediaRetry();
      return "reenviado";
    });
    expect(await withStaleMediaRetry(run)).toBe("reenviado");
    expect(run.mock.calls).toEqual([[false], [true, undefined]]);
  });
  it("si el reintento también falla, el error sale (dos intentos, jamás un bucle)", async () => {
    const run = vi.fn(async () => {
      throw new StaleMediaRetry();
    });
    await expect(withStaleMediaRetry(run)).rejects.toBeInstanceOf(StaleMediaRetry);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("otro error no se reintenta", async () => {
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(withStaleMediaRetry(run)).rejects.toThrow("boom");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
