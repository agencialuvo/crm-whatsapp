import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { isPublicSignupAllowed } from "@/server/auth/registration";

/**
 * El registro por HTTP está cerrado: las cuentas se crean por backend
 * (`pnpm crear-usuario`) o las del equipo las crea el propietario. La única
 * apertura es ALLOW_SIGNUP=true, que además muestra «Regístrate» en el acceso.
 */

afterEach(() => vi.unstubAllEnvs());

describe("registro por HTTP cerrado", () => {
  it("por defecto está cerrado, también en una instancia vacía", async () => {
    vi.stubEnv("ALLOW_SIGNUP", "");
    expect(await isPublicSignupAllowed()).toBe(false);
  });

  it("solo ALLOW_SIGNUP=true lo abre", async () => {
    vi.stubEnv("ALLOW_SIGNUP", "true");
    expect(await isPublicSignupAllowed()).toBe(true);
  });

  it("cualquier otro valor no lo abre", async () => {
    for (const v of ["1", "yes", "on", "TRUE", "false"]) {
      vi.stubEnv("ALLOW_SIGNUP", v);
      expect(await isPublicSignupAllowed(), v).toBe(false);
    }
  });
});

describe("el registro de la interfaz depende del interruptor", () => {
  it("el inicio de sesión solo enlaza «Regístrate» si la instancia lo permite", () => {
    const form = readFileSync("src/components/auth/login-form.tsx", "utf8");
    expect(form).toMatch(/signupEnabled && \([\s\S]{0,200}href="\/registro"/);
    const page = readFileSync("src/app/(auth)/iniciar-sesion/page.tsx", "utf8");
    expect(page).toContain("isPublicSignupAllowed()");
    expect(form).not.toContain("Crear la cuenta inicial");
  });

  it("la pantalla de registro se niega si el interruptor está apagado", () => {
    const page = readFileSync("src/app/(auth)/registro/page.tsx", "utf8");
    expect(page).toMatch(/!\(await isPublicSignupAllowed\(\)\)[\s\S]{0,400}Registro no disponible/);
  });

  it("el formulario manda el desafío del captcha de la acción de registro", () => {
    const form = readFileSync("src/components/auth/registro-form.tsx", "utf8");
    expect(form).toContain("CAPTCHA_ACTIONS.signup");
    expect(form).toContain("CAPTCHA_HEADER");
  });

  it("el cliente de autenticación no desestructura signUp (solo lo usa el formulario de registro)", () => {
    const client = readFileSync("src/lib/auth/client.ts", "utf8");
    expect(client).not.toMatch(/signUp/);
  });

  it("el hook del servidor bloquea /sign-up/email salvo bypass interno", () => {
    const auth = readFileSync("src/lib/auth/index.ts", "utf8");
    expect(auth).toMatch(/ctx\.path === "\/sign-up\/email"[\s\S]{0,200}isInternal\("signup"\)[\s\S]{0,120}isPublicSignupAllowed\(\)/);
  });
});
