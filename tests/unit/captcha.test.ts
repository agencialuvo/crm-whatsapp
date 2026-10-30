import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTCHA_HEADER, CAPTCHA_PROOF_HEADER } from "@/lib/captcha";
import {
  captchaEnabled,
  issueCaptchaProof,
  verifyCaptchaHeader,
  verifyCaptchaProof,
  verifyCaptchaToken,
} from "@/server/auth/captcha";

function googleReplies(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("reCAPTCHA v3 (servidor)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_RECAPTCHA_SITE_KEY", "site-key");
    vi.stubEnv("RECAPTCHA_SECRET_KEY", "secret-key");
    vi.stubEnv("RECAPTCHA_MIN_SCORE", "");
    vi.stubEnv("RECAPTCHA_VERIFY_URL", "");
    vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    vi.stubEnv("DATABASE_URL", "postgresql://t:t@localhost:5432/t");
    vi.stubEnv("BETTER_AUTH_SECRET", "secret-de-test-suficiente");
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"));
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "verify-test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("apagado sin las dos claves: deja pasar sin consultar a Google", async () => {
    vi.stubEnv("RECAPTCHA_SECRET_KEY", "");
    const fetchMock = googleReplies({ success: false });
    expect(captchaEnabled()).toBe(false);
    expect(await verifyCaptchaToken(undefined, "login")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sin token: rechaza sin consultar a Google", async () => {
    const fetchMock = googleReplies({ success: true, score: 0.9, action: "login" });
    expect(await verifyCaptchaToken("", "login")).toBe(false);
    expect(await verifyCaptchaToken(null, "login")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("acepta un token bueno de la acción pedida y manda secreto, token e IP", async () => {
    const fetchMock = googleReplies({ success: true, score: 0.9, action: "login" });
    expect(await verifyCaptchaToken("tok", "login", "1.2.3.4")).toBe(true);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const sent = new URLSearchParams(String(init.body));
    expect(sent.get("secret")).toBe("secret-key");
    expect(sent.get("response")).toBe("tok");
    expect(sent.get("remoteip")).toBe("1.2.3.4");
  });

  it("rechaza token inválido, de otra acción o de baja puntuación", async () => {
    googleReplies({ success: false, "error-codes": ["invalid-input-response"] });
    expect(await verifyCaptchaToken("tok", "login")).toBe(false);
    googleReplies({ success: true, score: 0.9, action: "password_reset" });
    expect(await verifyCaptchaToken("tok", "login")).toBe(false);
    googleReplies({ success: true, score: 0.3, action: "login" });
    expect(await verifyCaptchaToken("tok", "login")).toBe(false);
  });

  it("la puntuación mínima se ajusta con RECAPTCHA_MIN_SCORE", async () => {
    vi.stubEnv("RECAPTCHA_MIN_SCORE", "0.2");
    googleReplies({ success: true, score: 0.3, action: "login" });
    expect(await verifyCaptchaToken("tok", "login")).toBe(true);
  });

  it("degradación: si Google cae o la secreta es inválida, no bloquea el acceso", async () => {
    googleReplies({}, 500);
    expect(await verifyCaptchaToken("tok", "login")).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("sin red"))));
    expect(await verifyCaptchaToken("tok", "login")).toBe(true);
    googleReplies({ success: false, "error-codes": ["invalid-input-secret"] });
    expect(await verifyCaptchaToken("tok", "login")).toBe(true);
  });

  it("lee el token de la cabecera", async () => {
    const fetchMock = googleReplies({ success: true, score: 0.9, action: "login" });
    const headers = new Headers({ [CAPTCHA_HEADER]: "desde-cabecera" });
    expect(await verifyCaptchaHeader(headers, "login")).toBe(true);
    expect(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).toContain("desde-cabecera");
    expect(await verifyCaptchaHeader(new Headers(), "login")).toBe(false);
  });

  describe("constancia del paso 1 del login", () => {
    const withProof = (p: string) => new Headers({ [CAPTCHA_PROOF_HEADER]: p });

    it("sirve para el mismo correo (sin importar mayúsculas) y no para otro", () => {
      const proof = issueCaptchaProof("Ana@Correo.com");
      expect(verifyCaptchaProof(withProof(proof), "ana@correo.com")).toBe(true);
      expect(verifyCaptchaProof(withProof(proof), "otra@correo.com")).toBe(false);
    });

    it("rechaza una constancia alterada, vencida o ausente", () => {
      const proof = issueCaptchaProof("ana@correo.com");
      expect(verifyCaptchaProof(withProof(`${proof}x`), "ana@correo.com")).toBe(false);
      expect(verifyCaptchaProof(withProof("123.abc"), "ana@correo.com")).toBe(false);
      expect(verifyCaptchaProof(new Headers(), "ana@correo.com")).toBe(false);
      vi.useFakeTimers();
      try {
        const old = issueCaptchaProof("ana@correo.com");
        vi.setSystemTime(Date.now() + 6 * 60 * 1000);
        expect(verifyCaptchaProof(withProof(old), "ana@correo.com")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
