import { describe, expect, it } from "vitest";
import {
  buildSignatureManifest,
  canAdvancePayment,
  centsToMpAmount,
  changePlanBodySchema,
  checkoutBodySchema,
  classifyPayment,
  isAllowedCheckoutUrl,
  mapPreapprovalStatus,
  mpAmountToCents,
  normalizeDataId,
  parseSignatureHeader,
  rejectionMessage,
  signMp,
  verifyMpSignature,
} from "@/lib/billing";

const secret = "secreto-de-prueba";
const sign = (over: Partial<{ dataId: string; requestId: string; ts: string; secret: string }> = {}) => {
  const p = { dataId: "123456", requestId: "req-1", ts: "1700000000", secret, ...over };
  return { p, header: `ts=${p.ts},v1=${signMp(p)}` };
};

describe("firma del webhook", () => {
  it("el manifiesto sigue el formato de Mercado Pago y baja a minúsculas el data.id alfanumérico", () => {
    expect(buildSignatureManifest({ dataId: "ABC123", requestId: "r", ts: "9" })).toBe("id:abc123;request-id:r;ts:9;");
    expect(normalizeDataId("a-B")).toBe("a-B");
  });

  it("una firma válida pasa", () => {
    const { p, header } = sign();
    expect(verifyMpSignature({ secret, signatureHeader: header, requestId: p.requestId, dataId: p.dataId })).toBe(true);
  });

  it("acepta el data.id en mayúsculas (se normaliza igual que al firmar)", () => {
    const { p, header } = sign({ dataId: "ABC123" });
    expect(verifyMpSignature({ secret, signatureHeader: header, requestId: p.requestId, dataId: "abc123" })).toBe(true);
  });

  it.each([
    ["secreto distinto", { secret: "otro" }],
    ["ts alterado", { ts: "1700000001" }],
    ["request-id distinto", { requestId: "req-2" }],
    ["data.id distinto", { dataId: "999" }],
  ])("rechaza: %s", (_n, over) => {
    const { p, header } = sign();
    const bad = { secret, signatureHeader: header, requestId: p.requestId, dataId: p.dataId, ...over };
    // el secreto distinto se prueba firmando con otro, el resto alterando lo recibido
    if ("secret" in over) {
      expect(verifyMpSignature({ ...bad, secret: over.secret as string })).toBe(false);
    } else if ("ts" in over) {
      expect(verifyMpSignature({ ...bad, signatureHeader: `ts=${over.ts},v1=${header.split("v1=")[1]}` })).toBe(false);
    } else {
      expect(verifyMpSignature(bad)).toBe(false);
    }
  });

  it("sin secreto, sin cabeceras o con partes faltantes: false y nunca lanza", () => {
    const { p, header } = sign();
    expect(verifyMpSignature({ secret: undefined, signatureHeader: header, requestId: p.requestId, dataId: p.dataId })).toBe(false);
    expect(verifyMpSignature({ secret, signatureHeader: null, requestId: p.requestId, dataId: p.dataId })).toBe(false);
    expect(verifyMpSignature({ secret, signatureHeader: "ts=1", requestId: p.requestId, dataId: p.dataId })).toBe(false);
    expect(verifyMpSignature({ secret, signatureHeader: "v1=abc", requestId: p.requestId, dataId: p.dataId })).toBe(false);
    expect(verifyMpSignature({ secret, signatureHeader: header, requestId: null, dataId: p.dataId })).toBe(false);
    expect(verifyMpSignature({ secret, signatureHeader: header, requestId: p.requestId, dataId: null })).toBe(false);
  });

  it("una firma de otro largo no lanza (timingSafeEqual exige largos iguales)", () => {
    expect(verifyMpSignature({ secret, signatureHeader: "ts=1,v1=abc", requestId: "r", dataId: "1" })).toBe(false);
  });

  it("parsea la cabecera con espacios y orden libre", () => {
    expect(parseSignatureHeader("v1=aa, ts=12")).toEqual({ ts: "12", v1: "aa" });
  });
});

describe("montos en soles", () => {
  it("céntimos → decimal de Mercado Pago y de vuelta", () => {
    expect(centsToMpAmount(7900)).toBe(79);
    expect(centsToMpAmount(14950)).toBe(149.5);
    expect(mpAmountToCents(79)).toBe(7900);
    expect(mpAmountToCents("149.00")).toBe(14900);
    expect(mpAmountToCents(0.1 + 0.2)).toBe(30); // sin errores de coma flotante
    for (const c of [1, 99, 7900, 14900, 29900]) expect(mpAmountToCents(centsToMpAmount(c))).toBe(c);
  });
  it("rechaza montos inválidos", () => {
    expect(() => centsToMpAmount(-1)).toThrow();
    expect(() => mpAmountToCents("abc")).toThrow();
  });
});

describe("estados de Mercado Pago", () => {
  it("mapea la suscripción", () => {
    expect(mapPreapprovalStatus("authorized")).toBe("authorized");
    expect(mapPreapprovalStatus("cancelled")).toBe("cancelled");
    expect(mapPreapprovalStatus("canceled")).toBe("cancelled");
    expect(mapPreapprovalStatus("paused")).toBe("paused");
    expect(mapPreapprovalStatus("lo-que-sea")).toBe("pending");
    expect(mapPreapprovalStatus(null)).toBe("pending");
  });
  it("clasifica el cobro por el pago que lo respalda", () => {
    expect(classifyPayment({ paymentStatus: "approved" })).toBe("approved");
    expect(classifyPayment({ paymentStatus: "rejected", authorizedStatus: "recycling" })).toBe("rejected");
    expect(classifyPayment({ paymentStatus: "refunded" })).toBe("refunded");
    expect(classifyPayment({ paymentStatus: "charged_back" })).toBe("charged_back");
    expect(classifyPayment({ authorizedStatus: "scheduled" })).toBe("pending");
    expect(classifyPayment({ authorizedStatus: "cancelled" })).toBe("cancelled");
  });
  it("el estado de un cobro solo avanza", () => {
    expect(canAdvancePayment(null, "pending")).toBe(true);
    expect(canAdvancePayment("pending", "rejected")).toBe(true);
    expect(canAdvancePayment("rejected", "approved")).toBe(true);
    expect(canAdvancePayment("approved", "rejected")).toBe(false);
    expect(canAdvancePayment("approved", "pending")).toBe(false);
    expect(canAdvancePayment("approved", "refunded")).toBe(true);
    expect(canAdvancePayment("refunded", "approved")).toBe(false);
  });
});

describe("redirección al pago", () => {
  it.each([
    ["https://www.mercadopago.com.pe/subscriptions/checkout?preapproval_id=1", true],
    ["https://mercadopago.com/x", true],
    ["https://sandbox.mercadopago.com.pe/x", true],
    ["http://www.mercadopago.com.pe/x", false],
    ["https://mercadopago.com.evil.com/x", false],
    ["https://evilmercadopago.com/x", false],
    ["https://evil.com/mercadopago.com", false],
    ["javascript:alert(1)", false],
    ["no es una url", false],
  ])("%s → %s", (url, ok) => expect(isAllowedCheckoutUrl(url)).toBe(ok));

  it("el host del mock solo entra si se declara", () => {
    expect(isAllowedCheckoutUrl("http://localhost:3002/api/dev/mp-mock/checkout/1")).toBe(false);
    expect(isAllowedCheckoutUrl("http://localhost:3002/api/dev/mp-mock/checkout/1", ["localhost:3002"])).toBe(true);
  });
});

describe("mensajes y contratos", () => {
  it("traduce el motivo del rechazo", () => {
    expect(rejectionMessage("cc_rejected_insufficient_amount")).toContain("fondos insuficientes");
    expect(rejectionMessage("desconocido")).toContain("rechazado");
    expect(rejectionMessage(null)).toContain("rechazado");
  });
  it("los cuerpos son estrictos", () => {
    expect(checkoutBodySchema.safeParse({ planId: "plan_x" }).success).toBe(true);
    expect(checkoutBodySchema.safeParse({ planId: "plan_x", organizationId: "org_otra" }).success).toBe(false);
    expect(checkoutBodySchema.safeParse({}).success).toBe(false);
    expect(changePlanBodySchema.safeParse({ planId: "" }).success).toBe(false);
  });
});
