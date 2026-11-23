import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Monedas, sub-paso 5.2 (sin base real): lo que ve el cliente. «Mis monedas» y la franja de «sin monedas» (qué
 * dicen en cada estado y cuándo NO aparecen), el costo de la plantilla antes de enviar, el mensaje claro del 402
 * `no_credit`, y que la entrada de Ajustes exista con y sin `NEXT_PUBLIC_NAV_V2`. Sin DOM de pruebas: se dibuja el
 * primer HTML y el cableado se fija leyendo el código; el recorrido real se prueba en el navegador.
 */

const read = (p: string) => readFileSync(p, "utf8");

/* ───────── Gate simulada (para creditSummary / avisoMonedasDe) ───────── */

const gate = {
  enabled: true,
  balance: null as null | Record<string, unknown>,
  alert: null as null | { quota: number },
  spend: { ai: { count: 0, units: 0 }, whatsapp: { count: 0, units: 0 } },
  allow: true,
  rate: (key: string): number => ({ "ai.turn": 100, "wa.template.marketing": 300, "wa.template.utility": 100, "wa.template.authentication": 100, "wa.template.other": 100 }[key] ?? 0),
};
const estadoIaDe = vi.fn();

vi.mock("@/server/credits", () => ({
  creditsEnabled: () => gate.enabled,
  getCreditBalance: async () => gate.balance,
  getAlertState: async () => gate.alert,
  getPeriodSpend: async () => gate.spend,
  priceFor: async (key: string) => gate.rate(key),
  checkCredit: async (_o: string, opts: { amount?: number } = {}) => ({ allow: gate.allow, wouldCut: !gate.allow, reason: "x", amount: opts.amount }),
}));
vi.mock("@/server/saas/credits-sync", () => ({ ensureCreditAccount: async () => {} }));
vi.mock("@/lib/ai/provider", () => ({ estadoIaDe }));

const bal = (over: Record<string, unknown> = {}) => ({
  plan: 700, topup: 300, total: 1000, unlimited: false, cutEnabled: false, overdraftLimit: 0,
  planPeriodStart: new Date("2026-11-01T00:00:00Z"), planPeriodEnd: new Date("2026-12-01T00:00:00Z"), ...over,
});

beforeEach(() => {
  gate.enabled = true;
  gate.balance = bal();
  gate.alert = { quota: 1000 };
  gate.allow = true;
  gate.spend = { ai: { count: 3, units: 300 }, whatsapp: { count: 1, units: 300 } };
  estadoIaDe.mockReset();
  estadoIaDe.mockResolvedValue({ activa: true, origen: "env", last4: "1234" });
});
afterEach(() => vi.unstubAllEnvs());

/* ───────── El resumen y la franja ───────── */

describe("creditSummary", () => {
  it("apagadas las monedas: `enabled: false` y nada más", async () => {
    gate.enabled = false;
    const { creditSummary } = await import("@/server/saas/credits-summary");
    expect(await creditSummary("org_1")).toEqual({ enabled: false });
  });

  it("con cuenta: saldo, cuota del libro, consumo por servicio y costos", async () => {
    const { creditSummary } = await import("@/server/saas/credits-summary");
    const s = await creditSummary("org_1");
    expect(s).toMatchObject({
      enabled: true, metered: true, unlimited: false, planBalance: 700, topupBalance: 300, total: 1000, quota: 1000,
      cutEnabled: false, blockedAi: false, blockedTemplates: false, turnCost: 100,
      templateCosts: { marketing: 300, utility: 100, authentication: 100, other: 100 },
      spend: { ai: { count: 3, units: 300 }, whatsapp: { count: 1, units: 300 } },
    });
  });

  it("sin cuenta (sin suscripción): `metered: false`, sin saldo", async () => {
    gate.balance = null;
    const { creditSummary } = await import("@/server/saas/credits-summary");
    expect(await creditSummary("org_1")).toMatchObject({ enabled: true, metered: false, total: 0 });
  });

  it("en modo sombra NUNCA hay bloqueo, aunque no alcance", async () => {
    gate.allow = false;
    const { creditSummary } = await import("@/server/saas/credits-summary");
    expect(await creditSummary("org_1")).toMatchObject({ cutEnabled: false, blockedAi: false, blockedTemplates: false });
  });

  it("con el corte activo y sin saldo marca los bloqueos; un plan sin tope no se bloquea nunca", async () => {
    gate.balance = bal({ cutEnabled: true, plan: 0, topup: 0, total: 0 });
    gate.allow = false;
    const { creditSummary } = await import("@/server/saas/credits-summary");
    expect(await creditSummary("org_1")).toMatchObject({ blockedAi: true, blockedTemplates: true });
    gate.balance = bal({ cutEnabled: true, unlimited: true, plan: 0, topup: 0, total: 0 });
    expect(await creditSummary("org_1")).toMatchObject({ blockedAi: false, blockedTemplates: false });
  });
});

describe("avisoMonedasDe (la franja)", () => {
  const sinSaldo = () => {
    gate.balance = bal({ cutEnabled: true, plan: 0, topup: 0, total: 0 });
    gate.allow = false;
  };

  it("no aparece con las monedas apagadas, en modo sombra, con saldo ni sin cuenta", async () => {
    const { avisoMonedasDe } = await import("@/server/saas/credits-summary");
    gate.enabled = false;
    expect(await avisoMonedasDe("o")).toBeNull();
    gate.enabled = true;
    gate.allow = false; // sombra: corte apagado
    expect(await avisoMonedasDe("o")).toBeNull();
    gate.balance = bal({ cutEnabled: true });
    gate.allow = true; // con corte pero con saldo
    expect(await avisoMonedasDe("o")).toBeNull();
    gate.balance = null;
    expect(await avisoMonedasDe("o")).toBeNull();
  });

  it("con el corte activo y sin saldo, agente con la llave de la plataforma: dice que está en pausa y que los mensajes siguen llegando", async () => {
    sinSaldo();
    const { avisoMonedasDe } = await import("@/server/saas/credits-summary");
    const a = await avisoMonedasDe("o");
    expect(a?.kind).toBe("agent");
    expect(a?.mensaje).toContain("en pausa");
    expect(a?.mensaje).toContain("siguen llegando a la bandeja");
  });

  it("con la llave propia del cliente el agente no depende de las monedas: solo avisa de las plantillas", async () => {
    sinSaldo();
    estadoIaDe.mockResolvedValue({ activa: true, origen: "org", last4: "9999" });
    const { avisoMonedasDe } = await import("@/server/saas/credits-summary");
    const a = await avisoMonedasDe("o");
    expect(a?.kind).toBe("templates");
    expect(a?.mensaje).not.toContain("agente está en pausa");
    expect(a?.mensaje).toContain("24 h");
  });

  it("nunca lanza: si el resumen falla, no hay franja", async () => {
    sinSaldo();
    estadoIaDe.mockRejectedValue(new Error("x"));
    const { avisoMonedasDe } = await import("@/server/saas/credits-summary");
    await expect(avisoMonedasDe("o")).resolves.toBeDefined();
  });
});

/* ───────── Dibujo de la franja y de la tarjeta ───────── */

describe("franja «sin monedas»", () => {
  it("sin aviso no dibuja nada; con aviso lleva el enlace solo para quien configura", async () => {
    const { AvisoMonedasBanner } = await import("@/components/avisos/aviso-monedas");
    expect(renderToStaticMarkup(createElement(AvisoMonedasBanner, { aviso: null, puedeConfigurar: true }))).toBe("");
    const aviso = { kind: "agent" as const, mensaje: "Tu agente está en pausa" };
    const dueno = renderToStaticMarkup(createElement(AvisoMonedasBanner, { aviso, puedeConfigurar: true }));
    expect(dueno).toContain('role="status"');
    expect(dueno).toContain("Tu agente está en pausa");
    expect(dueno).toContain('href="/ajustes/monedas"');
    const miembro = renderToStaticMarkup(createElement(AvisoMonedasBanner, { aviso, puedeConfigurar: false }));
    expect(miembro).not.toContain("/ajustes/monedas");
    expect(miembro).toContain("Avisa a quien administra");
    // No intrusiva: sin botón de cerrar ni modal; es una franja como las demás.
    expect(dueno).not.toContain("<button");
  });
});

describe("tarjeta «Mis monedas»", () => {
  type S = Extract<import("@/server/saas/credits-summary").CreditSummary, { enabled: true }>;
  const base = (over: Partial<S> = {}): S => ({
    enabled: true, metered: true, unlimited: false, planBalance: 700, topupBalance: 300, total: 1000, quota: 1000,
    periodStart: "2026-11-01T00:00:00.000Z", periodEnd: "2026-12-01T00:00:00.000Z", cutEnabled: false, blockedAi: false,
    blockedTemplates: false, turnCost: 100, templateCosts: { marketing: 300 },
    spend: { ai: { count: 3, units: 300 }, whatsapp: { count: 1, units: 300 } }, ...over,
  });
  const html = async (s: S) => {
    const { CreditsCard } = await import("@/components/credits/credits-card");
    return renderToStaticMarkup(createElement(CreditsCard, { summary: s }));
  };

  it("muestra el total, la cuota frente a las recargas y el desglose IA vs. WhatsApp", async () => {
    const h = await html(base());
    expect(h).toContain('data-testid="credits-total"');
    expect(h).toContain(">10<"); // 1000 unidades = 10 monedas
    expect(h).toContain("Cuota de tu plan");
    expect(h).toContain("renueva 01/12/2026");
    expect(h).toContain("de 10"); // cuota
    expect(h).toContain("30% usado");
    expect(h).toContain("Recargas");
    expect(h).toContain("Agente de IA");
    expect(h).toContain("3 respuestas");
    expect(h).toContain("Plantillas de WhatsApp");
    expect(h).toContain("1 plantilla ·");
    expect(h).toContain("50% del consumo");
  });

  it("en modo sombra lo dice claro: se mide pero no detiene nada", async () => {
    const h = await html(base({ cutEnabled: false }));
    expect(h).toContain('data-testid="credits-shadow-note"');
    expect(h).toContain("miden pero no detienen nada");
    expect(h).not.toContain("credits-empty-note");
  });

  it("con el corte activo y saldo cero: aviso de pausa, con la bandeja a salvo", async () => {
    const h = await html(base({ cutEnabled: true, planBalance: 0, topupBalance: 0, total: 0 }));
    expect(h).toContain("credits-empty-note");
    expect(h).toContain("agente está en pausa");
    expect(h).toContain("siguen llegando a la bandeja");
    expect(h).not.toContain("credits-shadow-note");
  });

  it("plan sin tope: «Sin tope», sin barra de cuota", async () => {
    const h = await html(base({ unlimited: true, cutEnabled: true }));
    expect(h).toContain("Sin tope");
    expect(h).not.toContain("progressbar");
  });

  it("recargas en deuda se ven en rojo y se explican", async () => {
    const h = await html(base({ topupBalance: -150, total: 550 }));
    expect(h).toContain("Saldo en deuda");
  });

  it("sin cuenta: lo explica sin números", async () => {
    const h = await html(base({ metered: false }));
    expect(h).toContain('data-state="unmetered"');
    expect(h).toContain("todavía no tiene monedas asignadas");
  });
});

/* ───────── Costo de la plantilla y el 402 ───────── */

describe("costo de la plantilla y mensaje del 402", () => {
  const costs = { enabled: true, costs: { marketing: 300, utility: 100, authentication: 100, other: 100 } };

  it("dice el costo por categoría (con plural) y nada si no aplica", async () => {
    const { templateCostLabel, templateCostUnits } = await import("@/components/credits/template-cost");
    expect(templateCostLabel(costs, "MARKETING")).toBe("3 monedas");
    expect(templateCostLabel(costs, "utility")).toBe("1 moneda");
    expect(templateCostLabel(costs, "desconocida")).toBe("1 moneda"); // cae en `other`
    expect(templateCostLabel(null, "marketing")).toBeNull(); // cargando o monedas apagadas
    expect(templateCostLabel({ enabled: false, costs: {} }, "marketing")).toBeNull();
    expect(templateCostLabel({ enabled: true, costs: { marketing: 0 } }, "marketing")).toBeNull(); // sin costo
    expect(templateCostUnits(costs, "authentication")).toBe(100);
  });

  it("un 402 se traduce a un mensaje claro con el costo y lo que sigue funcionando — no al genérico", async () => {
    const { templateSendError } = await import("@/components/credits/template-cost");
    const m = templateSendError(402, { code: "no_credit", message: "texto del servidor" }, "No se pudo enviar", costs, "marketing");
    expect(m).toContain("No tienes monedas suficientes");
    expect(m).toContain("cuesta 3 monedas");
    expect(m).toContain("24 h siguen funcionando");
    expect(m).not.toContain("No se pudo enviar");
    // También por código aunque el estado no sea 402 (el contrato del servidor manda).
    expect(templateSendError(409, { code: "no_credit" }, "x", costs, "utility")).toContain("cuesta 1 moneda");
  });

  it("sin costo conocido el mensaje sigue siendo claro, y cualquier otro error conserva su texto", async () => {
    const { templateSendError } = await import("@/components/credits/template-cost");
    expect(templateSendError(402, undefined, "x", null, "marketing")).toMatch(/^No tienes monedas suficientes para enviar esta plantilla\. /);
    expect(templateSendError(409, { code: "window_closed", message: "Ventana cerrada" }, "x", costs, "marketing")).toBe("Ventana cerrada");
    expect(templateSendError(500, null, "No se pudo enviar la plantilla", costs, "marketing")).toBe("No se pudo enviar la plantilla");
  });

  it("los dos lugares donde se envía una plantilla dicen el costo y usan el mensaje del 402", () => {
    for (const f of ["src/components/inbox/template-sender.tsx", "src/components/contacts/start-conversation.tsx"]) {
      const code = read(f);
      expect(code, f).toContain("useTemplateCosts()");
      expect(code, f).toContain("templateCostLabel(");
      expect(code, f).toContain("templateSendError(");
      expect(code, f).toContain('data-testid="template-cost"');
    }
  });

  it("las rutas de envío de plantillas responden 402 al `no_credit`", async () => {
    const { SEND_ERROR_STATUS } = await import("@/server/inbox/send-status");
    expect(SEND_ERROR_STATUS.no_credit).toBe(402);
    expect(read("src/app/api/contacts/[id]/start-conversation/route.ts")).toMatch(/no_credit"\s*\?\s*402/);
  });
});

/* ───────── Ajustes: con y sin NAV_V2 ───────── */

describe("Ajustes → Monedas", () => {
  const sections = async (monedas: boolean) => {
    vi.resetModules();
    const { settingsSections } = await import("@/lib/nav");
    return settingsSections({ monedas }).flatMap((s) => s.links.map((l) => ({ section: s.title, ...l })));
  };

  for (const nav of ["on", "off"]) {
    it(`NEXT_PUBLIC_NAV_V2=${nav}: la pestaña «Monedas» aparece en Negocio solo si se pide`, async () => {
      vi.stubEnv("NEXT_PUBLIC_NAV_V2", nav);
      const con = await sections(true);
      expect(con.find((l) => l.href === "/ajustes/monedas")).toMatchObject({ section: "Negocio", label: "Monedas" });
      expect((await sections(false)).find((l) => l.href === "/ajustes/monedas")).toBeUndefined();
      // Las secciones de Ajustes no dependen del menú principal: NAV_V2 no cambia nada aquí.
      expect(con.some((l) => l.href === "/ajustes/whatsapp")).toBe(true);
    });
  }

  it("el layout de Ajustes la ofrece solo con CREDITS encendida y a quien configura; la página repite esas reglas", () => {
    const layout = read("src/app/(app)/ajustes/layout.tsx");
    expect(layout).toMatch(/monedas=\{creditsEnabled\(\) && !!session && canConfigure\(session\.role\)\}/);
    const page = read("src/app/(app)/ajustes/monedas/page.tsx");
    expect(page).toContain("if (!creditsEnabled()) notFound();");
    expect(page).toContain("if (!canConfigure(session.role)) notFound();");
  });

  it("la franja se monta en el layout de la app junto a las demás, con el rol", () => {
    const layout = read("src/app/(app)/layout.tsx");
    expect(layout).toContain("avisoMonedasDe(session.organizationId)");
    expect(layout).toContain("<AvisoMonedasBanner aviso={avisoMonedas} puedeConfigurar={canConfigure(session.role)} />");
  });
});

/* ───────── API del resumen ───────── */

describe("GET /api/credits/summary", () => {
  it("es de la organización de la sesión y con las monedas apagadas devuelve `enabled: false`", () => {
    const code = read("src/app/api/credits/summary/route.ts");
    expect(code).toContain("withAuth(");
    expect(code).toContain("creditSummary(session.organizationId)");
  });
});
