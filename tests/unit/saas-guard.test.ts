import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// La consulta de plan: una fila (suscripción + plan) o nada.
let row: { name: string; features: { modules: string[] } } | undefined;
vi.mock("@/lib/db", () => {
  const chain = { from: () => chain, innerJoin: () => chain, where: () => chain, limit: async () => (row ? [row] : []) };
  return { getDb: () => ({ select: () => chain }), schema: { plan: {}, subscription: {} } };
});
vi.mock("@/lib/db/tenant", () => ({ scoped: () => undefined }));

import { enforceModuleAccess, moduleGate, UpgradeRequiredError } from "@/server/business/saas-guard";

describe("candado de módulos por plan", () => {
  beforeEach(() => {
    row = undefined;
  });

  it("sin suscripción no restringe nada (organizaciones anteriores al módulo SaaS)", async () => {
    await expect(enforceModuleAccess("org_1", "finances")).resolves.toMatchObject({ unrestricted: true });
    expect(await moduleGate("org_1", "salon")).toBeNull();
  });

  it("un módulo incluido en el plan pasa", async () => {
    row = { name: "Pro", features: { modules: ["agenda", "finances"] } };
    expect(await moduleGate("org_1", "finances")).toBeNull();
  });

  it("un módulo fuera del plan responde 403 UPGRADE_REQUIRED con el contrato de error", async () => {
    row = { name: "Básico", features: { modules: ["agenda"] } };
    const res = await moduleGate("org_1", "finances");
    expect(res?.status).toBe(403);
    const body = (await res!.json()) as { error: { code: string; message: string; modules: string[]; plan: string } };
    expect(body.error.code).toBe("UPGRADE_REQUIRED");
    expect(body.error.modules).toEqual(["finances"]);
    expect(body.error.plan).toBe("Básico");
    expect(body.error.message).toMatch(/^UPGRADE_REQUIRED/);
  });

  it("enforceModuleAccess lanza el error tipado", async () => {
    row = { name: "Básico", features: { modules: ["agenda"] } };
    await expect(enforceModuleAccess("org_1", "salon")).rejects.toBeInstanceOf(UpgradeRequiredError);
  });

  it("con varios módulos basta con uno («cualquiera de»)", async () => {
    row = { name: "Básico", features: { modules: ["agenda"] } };
    expect(await moduleGate("org_1", ["finances", "agenda"])).toBeNull();
    expect((await moduleGate("org_1", ["finances", "salon"]))?.status).toBe(403);
  });
});

/**
 * Guardarraíl: lo que se añada a futuro no puede saltarse el plan. Si un route handler usa
 * `salonGate` o `agendaEnabled`, o una página usa `requireSalonPage`, debe haber pasado también
 * por el candado del plan. Falla con el archivo exacto, en vez de dejar un hueco silencioso.
 */
function walk(dir: string, name: RegExp, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, name, out);
    else if (name.test(f)) out.push(p);
  }
  return out;
}

describe("guardarraíl: ninguna superficie de un módulo sin candado de plan", () => {
  it("cada route handler con salonGate/agendaEnabled también llama a moduleGate", () => {
    const sin = walk("src/app/api", /^route\.ts$/)
      .filter((p) => !p.includes("/dev/") && !p.includes("\dev\\"))
      .filter((p) => {
        const s = readFileSync(p, "utf8");
        return /salonGate\(|agendaEnabled\(\)/.test(s) && !/moduleGate\(/.test(s);
      });
    expect(sin).toEqual([]);
  });

  it("cada página con requireSalonPage declara su módulo, y las de agenda llaman a requirePlanModule", () => {
    const pages = walk("src/app/(app)", /^page\.tsx$/);
    const sinModulo = pages.filter((p) => {
      const s = readFileSync(p, "utf8");
      return /requireSalonPage\(/.test(s) && !/module:/.test(s);
    });
    expect(sinModulo).toEqual([]);
    const agenda = pages.filter((p) => {
      const s = readFileSync(p, "utf8");
      return /agendaEnabled\(\)/.test(s) && /notFound\(\)/.test(s) && !/requirePlanModule\(/.test(s);
    });
    expect(agenda).toEqual([]);
  });
});
