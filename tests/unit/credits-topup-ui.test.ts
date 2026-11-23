import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Monedas, 5.5 (sin base real y sin red): la pantalla de compra de recargas en Ajustes → Monedas. Qué dice en cada
 * estado de la compra (pendiente, acreditada, cancelada/fallida, reembolsada, pasarela no disponible), cómo se traducen
 * los errores de la API, que el checkout solo se arma con una llave PÚBLICA, y el cableado (rutas, página, política de
 * seguridad apagada por defecto). Sin DOM: se dibuja el primer HTML y el cableado se fija leyendo el código.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const read = (p: string) => readFileSync(p, "utf8");
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe("lo puro de la pantalla de compra", () => {
  it("solo una llave pública pk_ de Culqi llega al checkout: una secreta o basura no se usa jamás", async () => {
    const { isPublicKey, checkoutConfig } = await import("@/lib/credits-topup-ui");
    for (const ok of ["pk_test_AbC123", "pk_live_xYz789"]) expect(isPublicKey(ok)).toBe(true);
    for (const bad of ["sk_test_AbC123", "sk_live_x", "pk_AbC", "pk_test_", "", null, undefined, "pk_test_a b", "Bearer pk_test_x"]) expect(isPublicKey(bad as never)).toBe(false);
    const order = { orderId: "ord_1", amountCents: 4990, currency: "PEN" };
    expect(checkoutConfig({ ...order, publicKey: "sk_test_SECRETA" })).toBeNull();
    expect(checkoutConfig({ ...order, publicKey: null })).toBeNull();
    expect(checkoutConfig({ ...order, orderId: "", publicKey: "pk_test_x" })).toBeNull();
    const cfg = checkoutConfig({ ...order, publicKey: "pk_test_x" })!;
    expect(cfg.publicKey).toBe("pk_test_x");
    expect(cfg.config.settings).toEqual({ title: "Recarga de monedas", currency: "PEN", amount: 4990, order: "ord_1" });
    expect(JSON.stringify(cfg)).not.toMatch(/sk_|secret/i);
  });

  it("cada estado de la compra dice algo claro y solo los definitivos dejan de consultarse", async () => {
    const { topupView } = await import("@/lib/credits-topup-ui");
    expect(topupView("paid")).toMatchObject({ tone: "success", terminal: true, title: "Recarga acreditada" });
    expect(topupView("failed")).toMatchObject({ tone: "danger", terminal: true });
    expect(topupView("abandoned")).toMatchObject({ tone: "neutral", terminal: true });
    expect(topupView("refunded")).toMatchObject({ terminal: true });
    expect(topupView("pending")).toMatchObject({ tone: "info", terminal: false, title: "Esperando la confirmación del pago" });
    expect(topupView("pending", { timedOut: true })).toMatchObject({ terminal: false, title: "Seguimos esperando la confirmación" });
    expect(topupView(null)).toMatchObject({ title: "" });
    // Si pagó pero el estado quedó abandonado, el texto no lo asusta: avisa que se acreditará.
    expect(topupView("abandoned").text).toMatch(/aparecer/);
  });

  it("los errores de la API se traducen a un mensaje claro (paquete, pendientes, dueño, tasa, pasarela)", async () => {
    const { purchaseErrorMessage: m } = await import("@/lib/credits-topup-ui");
    expect(m(404, "pack_not_found")).toMatch(/ya no está disponible/);
    expect(m(429, "too_many_pending")).toMatch(/sin completar/);
    expect(m(403, "forbidden")).toMatch(/dueño/);
    expect(m(429, "rate_limited")).toMatch(/Espera/);
    expect(m(503, "not_configured")).toMatch(/no están disponibles/);
    expect(m(404, "not_found")).toMatch(/no están disponibles/);
    expect(m(502, "gateway_error")).toMatch(/No se pudo iniciar el pago/);
    expect(m(0)).toMatch(/No se pudo iniciar el pago/);
    for (const [s, c] of [[404, "pack_not_found"], [503, "x"], [502, "y"], [0, undefined]] as const) expect(m(s, c)).not.toMatch(/Culqi|sk_|token/i);
  });
});

describe("lo que se dibuja", () => {
  const packs = [
    { id: "crk_1", name: "Recarga 500", units: 50_000, priceCents: 4990, currency: "PEN" },
    { id: "crk_2", name: "Recarga 1000", units: 100_000, priceCents: 8990, currency: "PEN" },
  ];
  const props = { failed: false, disabled: false, busyId: null, onBuy: () => {}, onRetry: () => {} };

  it("la lista muestra nombre, monedas, precio y precio por moneda, y un botón por paquete", async () => {
    const { PackGrid } = await import("@/components/credits/credits-topup");
    const out = html(createElement(PackGrid, { ...props, packs }));
    expect(out).toContain("Recarga 500");
    expect(out).toContain("Recarga 1000");
    expect(out).toMatch(/500 monedas/);
    expect(out).toMatch(/49[.,]90/);
    expect(out).toMatch(/0[.,]10 por moneda/); // 4990 cents / 500 monedas ≈ S/ 0,10
    expect((out.match(/data-testid="buy-pack"/g) ?? []).length).toBe(2);
    expect(out).not.toMatch(/ disabled=""/);
  });

  it("sin permiso o con la pasarela apagada los botones quedan desactivados", async () => {
    const { PackGrid } = await import("@/components/credits/credits-topup");
    const out = html(createElement(PackGrid, { ...props, packs, disabled: true }));
    expect((out.match(/ disabled=""/g) ?? []).length).toBe(2);
    expect(html(createElement(PackGrid, { ...props, packs, busyId: "crk_1" }))).toContain("Abriendo…");
  });

  it("estados de la lista: cargando, sin paquetes y con fallo (con Reintentar)", async () => {
    const { PackGrid } = await import("@/components/credits/credits-topup");
    expect(html(createElement(PackGrid, { ...props, packs: null }))).toContain("packs-loading");
    expect(html(createElement(PackGrid, { ...props, packs: [] }))).toContain("no hay paquetes disponibles");
    const f = html(createElement(PackGrid, { ...props, packs: null, failed: true }));
    expect(f).toContain("No se pudieron cargar");
    expect(f).toContain("Reintentar");
  });

  it("el aviso de estado: pendiente con «Verificar ahora»; acreditada con las monedas y el saldo nuevo, sin botón", async () => {
    const { StatusBanner } = await import("@/components/credits/credits-topup");
    const { topupView } = await import("@/lib/credits-topup-ui");
    const pend = html(createElement(StatusBanner, { view: topupView("pending"), newTotal: null, onVerify: () => {} }));
    expect(pend).toContain("Esperando la confirmación");
    expect(pend).toContain("topup-verify");
    const paid = html(createElement(StatusBanner, { view: topupView("paid"), units: 50_000, newTotal: 62_000, onVerify: () => {} }));
    expect(paid).toContain("Recarga acreditada");
    expect(paid).toMatch(/\+ 500 monedas/);
    expect(paid).toMatch(/saldo ahora: 620/);
    expect(paid).not.toContain("topup-verify");
    const failed = html(createElement(StatusBanner, { view: topupView("failed"), newTotal: null, onVerify: () => {} }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("No se te cobró nada");
    expect(failed).not.toContain("topup-credited");
  });

  it("la sección entera: pasarela apagada y no-dueño muestran su aviso y no dejan comprar", async () => {
    const { CreditsTopup } = await import("@/components/credits/credits-topup");
    const off = html(createElement(CreditsTopup, { canBuy: true, gatewayReady: false }));
    expect(off).toContain("topup-unavailable");
    expect(off).toContain("Las recargas no están disponibles por ahora");
    const member = html(createElement(CreditsTopup, { canBuy: false, gatewayReady: true }));
    expect(member).toContain("topup-owner-only");
    expect(member).not.toContain("topup-unavailable");
    const ok = html(createElement(CreditsTopup, { canBuy: true, gatewayReady: true }));
    expect(ok).not.toContain("topup-unavailable");
    expect(ok).not.toContain("topup-owner-only");
    expect(ok).toContain("Recargar monedas");
  });
});

describe("cableado y seguridad", () => {
  const comp = read("src/components/credits/credits-topup.tsx");
  const page = read("src/app/(app)/ajustes/monedas/page.tsx");

  it("usa SOLO las rutas del cliente: paquetes, compra, estado y resumen", () => {
    for (const r of ["/api/credits/packs", "/api/credits/topups", "/api/credits/topups/${encodeURIComponent(topupId)}", "/api/credits/summary"]) expect(comp).toContain(r);
    expect(comp).not.toMatch(/\/api\/super-admin|\/api\/webhooks|\/api\/billing/);
    expect(comp).toMatch(/method: "POST"/);
    // El cuerpo de la compra lleva solo el paquete: ni monto ni organización los decide el navegador.
    expect(comp).toContain("JSON.stringify({ packId: pack.id })");
  });

  it("no toca la base, la puerta de monedas ni secretos, y solo carga el script oficial de Culqi", () => {
    expect(comp).not.toMatch(/from "@\/server\/|from "@\/lib\/db|CULQI_SECRET|CULQI_WEBHOOK|process\.env|sk_(test|live)/);
    expect(comp).toContain("CULQI_CHECKOUT_SRC");
    expect(read("src/lib/credits-topup-ui.ts")).toContain('"https://js.culqi.com/checkout-js"');
    expect(comp).not.toMatch(/https?:\/\/(?!js\.culqi)/); // ninguna otra URL externa en la pantalla
    // El navegador nunca abona: no existe ninguna llamada a rutas que muevan saldo.
    expect(comp).not.toMatch(/applyTopup|refundTopup|adjustCredits/);
  });

  it("consulta el estado hasta que sea definitivo, refresca el saldo al acreditar y limpia el pendiente guardado", () => {
    expect(comp).toContain("POLL_MS");
    expect(comp).toContain("POLL_MAX_MS");
    expect(comp).toMatch(/topupView\(t\.status\)\.terminal/);
    expect(comp).toMatch(/fetch\("\/api\/credits\/summary"\)/);
    expect(comp).toContain("router.refresh()");
    expect(comp).toMatch(/remember\(null\)/);
    expect(comp).toContain("try {"); // el almacenamiento del navegador puede fallar
  });

  it("la página: solo con CREDITS encendida, solo quien configura; compra solo el dueño; pasarela según CULQI", () => {
    expect(page).toContain("if (!creditsEnabled()) notFound()");
    expect(page).toContain("canConfigure(session.role)");
    expect(page).toContain('canBuy={session.role === "owner"}');
    expect(page).toContain("gatewayReady={culqiEnabled()}");
    // Y es la misma página con o sin la navegación nueva (Ajustes tiene su propia barra lateral).
    expect(page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).not.toMatch(/NAV_V2/);
  });

  it("la política de seguridad solo se abre a Culqi con NEXT_PUBLIC_CULQI=on (apagado por defecto)", () => {
    const cfg = read("next.config.ts");
    expect(cfg).toContain('const CULQI_CSP = process.env.NEXT_PUBLIC_CULQI === "on"');
    expect(cfg).toMatch(/\$\{CULQI_CSP \? `/);
    // Los orígenes de Culqi nunca están escritos fuera de esa condición.
    const sinCondicion = cfg.replace(/CULQI_ORIGENES = "[^"]*"/, "").replace(/\$\{CULQI_CSP \? `[^`]*` : ""\}/g, "");
    expect(sinCondicion).not.toMatch(/culqi\.com/);
  });

  it("no se escribe directo a credit_* / billing_*: la pantalla solo usa la API", () => {
    for (const f of ["src/components/credits/credits-topup.tsx", "src/lib/credits-topup-ui.ts", "src/app/(app)/ajustes/monedas/page.tsx"]) {
      expect(read(f), f).not.toMatch(/schema\.(credit|billing)|insert\(|\.update\(/);
    }
  });
});
