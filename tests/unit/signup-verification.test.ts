import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { signupCodeEmail } from "@/server/email/templates";

describe("correo con el código de registro", () => {
  const mail = signupCodeEmail({ code: "493021", minutes: 10, productName: "Brothers" });

  it("lleva el código, la vigencia y el nombre del negocio", () => {
    expect(mail.subject).toContain("493021");
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("493021");
      expect(body).toContain("10 minutos");
      expect(body).toContain("Brothers");
    }
  });

  it("escapa el nombre escrito por el dueño en el HTML", () => {
    const evil = signupCodeEmail({ code: "000000", minutes: 10, productName: '<img src=x onerror="1">' });
    expect(evil.html).not.toContain("<img");
    expect(evil.html).toContain("&lt;img");
  });

  it("sin nombre de marca usa un texto neutro", () => {
    expect(signupCodeEmail({ code: "000000", minutes: 10, productName: "  " }).text).toContain("tu cuenta");
  });
});

describe("el registro no abre sesión ni crea negocio antes de verificar el correo", () => {
  const auth = readFileSync("src/lib/auth/index.ts", "utf8");

  it("Better Auth no inicia sesión al registrarse", () => {
    expect(auth).toMatch(/autoSignIn:\s*false/);
  });

  it("el alta pública no crea la organización: solo el alta interna del equipo pasa por onUserCreated", () => {
    expect(auth).not.toContain("onOwnerRegistered");
    expect(auth).toMatch(/isInternal\("signup"\)\)\s*await onUserCreated/);
  });

  it("el inicio de sesión público rechaza un registro sin verificar", () => {
    expect(auth).toMatch(/findPendingSignup\(email\)[\s\S]{0,200}INVALID_EMAIL_OR_PASSWORD/);
  });

  it("el negocio se crea solo al canjear el código, y la sesión la abre el servidor", () => {
    const verify = readFileSync("src/app/api/registro/verificar/route.ts", "utf8");
    expect(verify).toMatch(/consumeOtp\("signup-verify"[\s\S]*completeSignup\(user\)[\s\S]*signInEmail/);
    const service = readFileSync("src/server/auth/signup-verification.ts", "utf8");
    expect(service).toContain("onOwnerRegistered");
  });

  it("el código solo se manda y se canjea con la contraseña de la cuenta", () => {
    for (const f of ["src/app/api/registro/codigo/route.ts", "src/app/api/registro/verificar/route.ts"]) {
      expect(readFileSync(f, "utf8")).toContain("findPendingSignupWithPassword");
    }
  });

  it("el registro y su enlace exigen que haya correo configurado", () => {
    for (const f of ["src/app/(auth)/registro/page.tsx", "src/app/(auth)/iniciar-sesion/page.tsx"]) {
      expect(readFileSync(f, "utf8")).toContain("passwordResetAvailable()");
    }
  });
});
