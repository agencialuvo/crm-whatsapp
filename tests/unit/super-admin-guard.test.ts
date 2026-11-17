import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 045 — Guardarraíles del panel de Super Admin. Ninguno truena si se rompe: lo que se rompería es el
 * aislamiento entre negocios o la historia de las suscripciones, sin que nada lo avise. No los relajes:
 * si uno se pone rojo, enruta tu cambio por el camino correcto.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.join(ROOT, "src");

function archivos(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...archivos(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
const leer = (f: string) => readFileSync(f, "utf8");
const todos = archivos(SRC);

describe("el panel de Super Admin está aislado", () => {
  it("toda ruta bajo api/super-admin/ usa withSuperAdmin (ninguna se protege a mano)", () => {
    const rutas = todos.filter((f) => rel(f).startsWith("app/api/super-admin/") && f.endsWith("route.ts"));
    expect(rutas.length).toBeGreaterThanOrEqual(5);
    for (const f of rutas) {
      const code = leer(f);
      const metodos = [...code.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)];
      expect(metodos.length, rel(f)).toBeGreaterThan(0);
      for (const m of metodos) {
        // el handler exportado debe ser `withSuperAdmin(...)`
        expect(new RegExp(`export const ${m[1]} = withSuperAdmin\\(`).test(code), `${rel(f)} ${m[1]}`).toBe(true);
      }
      expect(code, rel(f)).not.toContain("withAuth(");
    }
  });

  it("nadie fuera de server/super-admin y api/super-admin importa el módulo cross-tenant", () => {
    const infractores: string[] = [];
    for (const f of todos) {
      const r = rel(f);
      if (r.startsWith("server/super-admin/") || r.startsWith("app/api/super-admin/")) continue;
      if (/from\s+["']@\/server\/super-admin\//.test(leer(f))) infractores.push(r);
    }
    expect(infractores, "Estos archivos leen datos de TODAS las organizaciones: ese módulo es solo del panel").toEqual([]);
  });

  it("el módulo cross-tenant no toca conversaciones, mensajes, contactos ni credenciales", () => {
    const prohibidas = [
      "schema.conversation",
      "schema.message",
      "schema.contact",
      "schema.credentials",
      "schema.template",
      "schema.kbEntry",
      "schema.lead",
      "schema.booking",
      "schema.serviceSale",
    ];
    for (const f of todos.filter((x) => rel(x).startsWith("server/super-admin/"))) {
      const code = leer(f);
      for (const p of prohibidas) expect(code, `${rel(f)} usa ${p}`).not.toContain(p);
    }
  });

  it("is_super_admin NO está expuesto por Better Auth (nadie se promueve por HTTP)", () => {
    const auth = leer(path.join(SRC, "lib/auth/index.ts"));
    expect(auth).not.toContain("additionalFields");
    expect(auth).not.toContain("isSuperAdmin");
    expect(auth).not.toContain("is_super_admin");
  });

  it("la bandera solo se escribe por la línea de comandos (scripts/superadmin.ts), jamás desde src/", () => {
    const infractores: string[] = [];
    for (const f of todos) {
      const code = leer(f);
      // una escritura de la columna: `.set({ isSuperAdmin: … })` o un insert con ella
      if (/\.set\(\s*\{[^}]*\bisSuperAdmin\s*:/.test(code) || /\.values\(\s*\{[^}]*\bisSuperAdmin\s*:/.test(code)) infractores.push(rel(f));
    }
    expect(infractores).toEqual([]);
  });

  it("el gate lee la base en cada petición (no la cookie) y exige el segundo factor", () => {
    const code = leer(path.join(SRC, "lib/auth/super-admin.ts"));
    expect(code).toContain("schema.user.isSuperAdmin");
    expect(code).toContain("twoFactorEnabled");
    expect(code).toContain("two_factor_required");
    expect(code).toContain("notFound()");
  });
});

describe("una sola puerta escribe la suscripción", () => {
  it("solo server/saas/subscription.ts inserta o actualiza `subscription` y `subscription_event`", () => {
    const infractores: string[] = [];
    for (const f of todos) {
      const r = rel(f);
      if (r === "server/saas/subscription.ts") continue;
      const code = leer(f);
      if (/(update|insert)\(\s*schema\.(subscription|subscriptionEvent)\s*\)/.test(code)) infractores.push(r);
    }
    expect(
      infractores,
      "Estos archivos cambian la suscripción sin registrar el movimiento. Usa applySubscriptionAction / startTrial / expireTrials de server/saas/subscription.ts:"
    ).toEqual([]);
  });

  it("la puerta sí escribe (el guardarraíl de arriba no quedó ciego)", () => {
    const code = leer(path.join(SRC, "server/saas/subscription.ts"));
    expect(/update\(\s*schema\.subscription\s*\)/.test(code)).toBe(true);
    expect(/insert\(\s*schema\.subscriptionEvent\s*\)/.test(code)).toBe(true);
  });

  it("el rastro del Super Admin solo lo escriben la puerta de la suscripción y el comando de línea de comandos", () => {
    const infractores: string[] = [];
    for (const f of todos) {
      const r = rel(f);
      if (r === "server/saas/subscription.ts") continue;
      if (/insert\(\s*schema\.superAdminAudit\s*\)/.test(leer(f))) infractores.push(r);
    }
    expect(infractores).toEqual([]);
  });
});
