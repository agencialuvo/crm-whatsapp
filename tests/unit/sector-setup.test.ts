import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { settingsSections } from "@/lib/nav";
import { SECTOR_KEY_PATTERN } from "@/lib/business-sector";

const read = (p: string) => readFileSync(p, "utf8");

describe("el registro queda limpio: no pregunta el sector", () => {
  it("ni el formulario, ni el envío del código, ni la verificación lo mencionan", () => {
    for (const f of [
      "src/components/auth/registro-form.tsx",
      "src/app/(auth)/registro/page.tsx",
      "src/app/api/registro/codigo/route.ts",
      "src/app/api/registro/verificar/route.ts",
      "src/server/auth/signup-verification.ts",
    ]) {
      expect(read(f), f).not.toMatch(/categoryKey|sector/i);
    }
  });

  it("el negocio nace con el sector por defecto y el asistente pendiente", () => {
    const s = read("src/server/auth/on-signup.ts");
    expect(s).toContain('DEFAULT_CATEGORY_KEY = "salon"');
    expect(s).toContain('sectorStatus: "pending"');
    // La migración deja `chosen` por defecto: una fila que no pasó por el alta nunca muestra el asistente.
    expect(read("src/lib/db/schema.ts")).toMatch(/sector_status[\s\S]{0,120}default\("chosen"\)/);
  });
});

describe("el asistente del panel", () => {
  const modal = read("src/components/onboarding/sector-setup-modal.tsx");
  const layout = read("src/app/(app)/layout.tsx");

  it("nunca bloquea: cerrar de cualquier forma equivale a «más tarde»", () => {
    expect(modal).toContain("onClose={skip}");
    expect(modal).toContain("Configurar más tarde");
    // «Más tarde» cierra sin esperar al servidor.
    expect(modal).toMatch(/function skip\(\) \{\s*setOpen\(false\)/);
  });

  it("solo se ofrece a quien configura y mientras esté pendiente; un fallo no tumba la app", () => {
    expect(layout).toMatch(/canConfigure\(session\.role\)/);
    expect(layout).toContain('status === "pending"');
    expect(layout).toMatch(/getSectorSetup\([^)]*\)\.catch\(\(\) => null\)/);
  });

  it("la API exige rol de configuración y solo hace dos cosas: elegir u omitir", () => {
    const api = read("src/app/api/organization/sector/route.ts");
    expect(api).toContain("canConfigure(session.role)");
    expect(api).toContain('z.literal("choose")');
    expect(api).toContain('z.literal("skip")');
  });

  it("cambiar de sector no mueve un plan contratado ni crea suscripciones", () => {
    const s = read("src/server/business/sector-setup.ts");
    expect(s).toContain('sub.status === "trialing"');
    expect(s).not.toMatch(/insert\(schema\.subscription\)/);
  });
});

describe("Ajustes → Tipo de negocio", () => {
  const links = (s: { title: string; links: { label: string }[] }[]) =>
    Object.fromEntries(s.map((x) => [x.title, x.links.map((l) => l.label)]));

  it("aparece en Negocio solo si la organización tiene perfil de sector", () => {
    expect(links(settingsSections({})).Negocio).not.toContain("Tipo de negocio");
    expect(links(settingsSections({ sector: true })).Negocio).toEqual([
      "Marca",
      "Plantillas",
      "Equipo",
      "Tipo de negocio",
    ]);
  });

  it("la llave del sector solo admite minúsculas, dígitos, guion y guion bajo", () => {
    expect(SECTOR_KEY_PATTERN.test("salon")).toBe(true);
    for (const bad of ["", "Salon", "a b", "../x", "x".repeat(41)]) expect(SECTOR_KEY_PATTERN.test(bad)).toBe(false);
  });
});
