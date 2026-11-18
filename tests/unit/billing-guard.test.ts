import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 046 — Guardarraíles del cobro con Mercado Pago. Lo que se rompería sin avisar: el cobro doble, una activación sin
 * historia, una credencial filtrada al navegador o un webhook que acepta avisos sin firma. No los relajes: enruta tu
 * cambio por el camino correcto.
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

/** ¿Este archivo escribe (insert/update/delete) la tabla? Mira `db.insert(schema.x)`, `tx.update(schema.x)`, etc. */
const escribe = (code: string, tabla: string) => new RegExp(`\\.(insert|update|delete)\\(\\s*schema\\.${tabla}\\b`).test(code);

describe("el cobro entra por la puerta única", () => {
  it("las columnas de la pasarela en `subscription` solo las escribe la puerta", () => {
    const campos = /\b(billingProvider|mpPreapprovalId|mpPayerId|mpStatus|billedAmountCents|billedCurrency|pendingPlanId|lastPaymentAt|nextPaymentAt)\s*:/;
    const infractores: string[] = [];
    for (const f of todos) {
      const r = rel(f);
      if (r === "server/saas/subscription.ts") continue;
      const code = leer(f);
      // Un `.update(schema.subscription)` seguido de `.set({ … campo … })`
      const bloques = [...code.matchAll(/\.update\(\s*schema\.subscription\s*\)\s*\.set\(\{([\s\S]*?)\}\)/g)];
      if (bloques.some((b) => campos.test(b[1] ?? ""))) infractores.push(r);
    }
    expect(infractores, "El estado, el plan y los datos de cobro de la suscripción se escriben SOLO en server/saas/subscription.ts").toEqual([]);
  });

  it("nadie fuera de la puerta escribe `subscription` ni `subscription_event`", () => {
    for (const f of todos) {
      const r = rel(f);
      if (r === "server/saas/subscription.ts") continue;
      const code = leer(f);
      expect(escribe(code, "subscription"), r).toBe(false);
      expect(escribe(code, "subscriptionEvent"), r).toBe(false);
    }
  });

  it("las tablas billing_* solo las escribe server/billing/ (y la puerta, bajo el candado de la organización)", () => {
    for (const f of todos) {
      const r = rel(f);
      if (r.startsWith("server/billing/") || r === "server/saas/subscription.ts") continue;
      const code = leer(f);
      for (const t of ["billingCheckout", "billingPayment", "billingWebhookEvent"]) {
        expect(escribe(code, t), `${r} escribe ${t}`).toBe(false);
      }
    }
  });

  it("solo la puerta escribe el estado por pago: applyPaymentEvent existe y usa el candado de fila", () => {
    const code = leer(path.join(SRC, "server/saas/subscription.ts"));
    expect(code).toContain("export async function applyPaymentEvent");
    expect(code).toMatch(/applyPaymentEvent[\s\S]*?\.for\("update"\)/);
    expect(code).toContain('source: "payment"');
  });
});

describe("el conector está aislado y las credenciales no se filtran", () => {
  it("nadie fuera de src/lib/mercadopago habla con la API de Mercado Pago", () => {
    for (const f of todos) {
      const r = rel(f);
      if (r.startsWith("lib/mercadopago/") || r.startsWith("app/api/dev/mp-mock/")) continue;
      expect(leer(f), r).not.toMatch(/api\.mercadopago\.com/);
    }
  });

  it("MP_ACCESS_TOKEN y MP_WEBHOOK_SECRET solo se leen en la configuración, el cliente y el mock", () => {
    const permitidos = new Set(["lib/mercadopago/config.ts", "lib/mercadopago/client.ts", "lib/env.ts", "server/doctor/checks.ts", "app/api/dev/mp-mock/[...path]/route.ts"]);
    for (const f of todos) {
      const r = rel(f);
      if (permitidos.has(r)) continue;
      expect(leer(f), r).not.toMatch(/MP_ACCESS_TOKEN|MP_WEBHOOK_SECRET/);
    }
  });

  it("ningún componente de cliente ni página importa el cliente de Mercado Pago ni su configuración", () => {
    for (const f of todos) {
      const r = rel(f);
      if (!(r.startsWith("components/") || /^app\/.*page\.tsx$/.test(r))) continue;
      const code = leer(f);
      // un componente de servidor (sin "use client") sí puede leer la bandera; nunca el cliente HTTP ni el token
      if (/^["']use client["']/.test(code.trimStart())) expect(code, r).not.toMatch(/lib\/mercadopago\//);
      else expect(code, r).not.toMatch(/lib\/mercadopago\/client/);
      expect(code, r).not.toMatch(/mpAccessToken|mpWebhookSecret/);
    }
  });

  it("el cliente nunca interpola el token en un mensaje de error", () => {
    const code = leer(path.join(SRC, "lib/mercadopago/client.ts"));
    expect(code).toContain("scrub(");
    expect(code).not.toMatch(/console\.(log|error)\([^)]*mpAccessToken/);
  });
});

describe("el webhook", () => {
  const route = leer(path.join(SRC, "app/api/webhooks/mercadopago/route.ts"));

  it("con la bandera apagada responde 404 antes que nada", () => {
    expect(route.indexOf("if (!billingEnabled())")).toBeGreaterThan(-1);
    expect(route.indexOf("if (!billingEnabled())")).toBeLessThan(route.indexOf("verifyMpSignature({"));
    expect(route).toMatch(/status:\s*404/);
  });

  it("verifica la firma ANTES de tocar la base", () => {
    expect(route.indexOf("verifyMpSignature({")).toBeGreaterThan(-1);
    expect(route.indexOf("verifyMpSignature({")).toBeLessThan(route.indexOf("handleNotification({"));
    expect(route).not.toMatch(/getDb|schema\./);
  });

  it("sin secreto no acepta nada (503) y firma inválida es 401", () => {
    expect(route).toMatch(/503/);
    expect(route).toMatch(/401/);
  });

  it("el aviso solo es un timbre: el estado se consulta a la API, no se lee del cuerpo", () => {
    const web = leer(path.join(SRC, "server/billing/webhook.ts"));
    expect(web).toMatch(/mp\.getAuthorizedPayment|syncPreapproval/);
    expect(web).not.toMatch(/body\.(status|payment)/);
  });
});

describe("las rutas /api/billing", () => {
  const rutas = todos.filter((f) => rel(f).startsWith("app/api/billing/") && f.endsWith("route.ts"));

  it("todas pasan por withBilling (404 apagadas, sesión y sin el corte por suscripción)", () => {
    expect(rutas.length).toBeGreaterThanOrEqual(5);
    for (const f of rutas) {
      const code = leer(f);
      for (const m of code.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)) {
        expect(new RegExp(`export const ${m[1]} = withBilling\\(`).test(code), `${rel(f)} ${m[1]}`).toBe(true);
      }
    }
  });

  it("las mutaciones exigen rol dueño y la organización sale de la sesión, nunca del cuerpo", () => {
    const guard = leer(path.join(SRC, "server/billing/guard.ts"));
    expect(guard).toMatch(/role !== "owner"/);
    expect(guard).toContain("allowInactive: true");
    for (const f of rutas) {
      const code = leer(f);
      if (/export const POST/.test(code)) expect(code, rel(f)).toMatch(/mutation:\s*true/);
      expect(code, rel(f)).not.toMatch(/body\.data\.organizationId/);
    }
  });
});
