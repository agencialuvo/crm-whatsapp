import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { isPublicSignupAllowed } from "@/server/auth/registration";

/**
 * El registro por HTTP está cerrado: las cuentas se crean por backend
 * (`pnpm crear-usuario`) o las del equipo las crea el propietario. La única
 * apertura es ALLOW_SIGNUP=true, para los arneses de prueba.
 */

afterEach(() => vi.unstubAllEnvs());

describe("registro por HTTP cerrado", () => {
  it("por defecto está cerrado, también en una instancia vacía", async () => {
    vi.stubEnv("ALLOW_SIGNUP", "");
    expect(await isPublicSignupAllowed()).toBe(false);
  });

  it("solo ALLOW_SIGNUP=true lo abre (escape para pruebas)", async () => {
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

describe("no hay forma de registrarse desde la interfaz", () => {
  it("la pantalla de registro no existe y el inicio de sesión no la enlaza", () => {
    const login = readFileSync("src/app/(auth)/iniciar-sesion/page.tsx", "utf8");
    expect(login).not.toContain("/registro");
    expect(login).not.toContain("Crear la cuenta inicial");
    expect(login).not.toContain("Primera vez");
    expect(() => readFileSync("src/app/(auth)/registro/page.tsx", "utf8")).toThrow();
  });

  it("el cliente de autenticación ya no expone signUp", () => {
    const client = readFileSync("src/lib/auth/client.ts", "utf8");
    expect(client).not.toMatch(/\bsignUp\b/);
  });

  it("el hook del servidor bloquea /sign-up/email salvo bypass interno", () => {
    const auth = readFileSync("src/lib/auth/index.ts", "utf8");
    expect(auth).toMatch(/ctx\.path === "\/sign-up\/email"[\s\S]{0,200}isInternal\("signup"\)[\s\S]{0,120}isPublicSignupAllowed\(\)/);
  });
});
