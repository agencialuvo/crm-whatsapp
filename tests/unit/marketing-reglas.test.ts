import { describe, expect, it } from "vitest";
import {
  birthdayAllowsItems,
  birthdayCampaignInputSchema,
  canRestrictServices,
  loyaltyMilestoneSchema,
  loyaltySettingsInputSchema,
  saleEarnsStamp,
  stampsAllowItems,
} from "@/lib/loyalty";

const svc = (id: string | null) => ({ serviceId: id, comboId: null });
const oferta = (id: string) => ({ serviceId: null, comboId: id });

describe("campaña de cumpleaños: qué ventas admiten el descuento", () => {
  it("sin lista aplica a cualquier venta con ítems", () => {
    expect(birthdayAllowsItems([], [svc("a")])).toBe(true);
    expect(birthdayAllowsItems([], [svc(null)])).toBe(true);
    expect(birthdayAllowsItems([], [])).toBe(false);
  });
  it("con lista, TODOS los ítems deben ser servicios permitidos", () => {
    expect(birthdayAllowsItems(["a", "b"], [svc("a")])).toBe(true);
    expect(birthdayAllowsItems(["a", "b"], [svc("a"), svc("b")])).toBe(true);
    expect(birthdayAllowsItems(["a"], [svc("a"), svc("facial")])).toBe(false);
  });
  it("una oferta marcada entra; una oferta sin marcar o un «Otro» no", () => {
    expect(birthdayAllowsItems(["a", "cmb_1"], [svc("a"), oferta("cmb_1")])).toBe(true);
    expect(birthdayAllowsItems(["a"], [oferta("cmb_1")])).toBe(false);
    expect(birthdayAllowsItems(["a"], [svc("a"), svc(null)])).toBe(false);
  });
  it("el porcentaje va de 1 a 100 y la lista se limpia de repetidos", () => {
    expect(birthdayCampaignInputSchema.safeParse({ enabled: true, percentage: -1, serviceIds: [] }).success).toBe(false);
    expect(birthdayCampaignInputSchema.safeParse({ enabled: true, percentage: 0, serviceIds: [] }).success).toBe(true);
    expect(birthdayCampaignInputSchema.safeParse({ enabled: true, percentage: 101, serviceIds: [] }).success).toBe(false);
    const ok = birthdayCampaignInputSchema.parse({ enabled: false, percentage: 20, serviceIds: ["a", "a", "b"] });
    expect(ok.serviceIds).toEqual(["a", "b"]);
  });
});

describe("tarjeta de fidelización: qué ventas dan sello", () => {
  it("sin lista, todo suma sello", () => {
    expect(stampsAllowItems([], [svc("a")])).toBe(true);
    expect(stampsAllowItems([], [svc(null)])).toBe(true);
  });
  it("con lista, basta UN servicio que dé sello", () => {
    expect(stampsAllowItems(["corte"], [svc("corte"), svc("facial")])).toBe(true);
    expect(stampsAllowItems(["corte"], [svc("facial")])).toBe(false);
    expect(stampsAllowItems(["corte"], [svc(null)])).toBe(false);
  });
  it("una oferta marcada también da sello; una sin marcar, no", () => {
    expect(stampsAllowItems(["cmb_1"], [oferta("cmb_1")])).toBe(true);
    expect(stampsAllowItems(["corte"], [oferta("cmb_1")])).toBe(false);
  });
});

describe("premios: servicios donde se canjean", () => {
  const base = { stamps: 8, title: "Premio" };
  it("un descuento y un servicio gratis admiten lista; un producto, no", () => {
    expect(canRestrictServices("percentage_discount")).toBe(true);
    expect(canRestrictServices("service_free")).toBe(true);
    expect(canRestrictServices("product_free")).toBe(false);
  });
  it("guarda serviceIds para el descuento y para el servicio gratis", () => {
    const d = loyaltyMilestoneSchema.parse({ ...base, rewardType: "percentage_discount", discountPercentage: 20, serviceIds: ["a", "b"] });
    expect(d.serviceIds).toEqual(["a", "b"]);
    const f = loyaltyMilestoneSchema.parse({ ...base, rewardType: "service_free", serviceIds: ["a"] });
    expect(f.serviceIds).toEqual(["a"]);
  });
  it("un producto gratis no guarda servicios", () => {
    const p = loyaltyMilestoneSchema.parse({ ...base, rewardType: "product_free", serviceIds: ["a"] });
    expect(p).not.toHaveProperty("serviceIds");
  });
  it("el formato anterior (un servicio) se pliega en la lista nueva", () => {
    const m = loyaltyMilestoneSchema.parse({ ...base, rewardType: "service_free", serviceIdRestriction: "x" });
    expect(m.serviceIds).toEqual(["x"]);
    expect(m).not.toHaveProperty("serviceIdRestriction");
  });
  it("el título es opcional: vacío o ausente usa el nombre del tipo de premio", () => {
    expect(loyaltyMilestoneSchema.parse({ stamps: 4, rewardType: "service_free" }).title).toBe("Servicio gratis");
    expect(loyaltyMilestoneSchema.parse({ stamps: 4, title: "   ", rewardType: "product_free" }).title).toBe("Producto gratis");
    expect(
      loyaltyMilestoneSchema.parse({ stamps: 4, title: "", rewardType: "percentage_discount", discountPercentage: 15 }).title
    ).toBe("15% de descuento");
  });
  it("si escribe un título, se respeta", () => {
    expect(loyaltyMilestoneSchema.parse({ stamps: 4, title: "Corte VIP", rewardType: "service_free" }).title).toBe("Corte VIP");
  });
  it("sin servicios marcados no se guarda lista (vale cualquiera)", () => {
    const m = loyaltyMilestoneSchema.parse({ ...base, rewardType: "service_free", serviceIds: [] });
    expect(m).not.toHaveProperty("serviceIds");
  });
});

describe("configuración de sellos: interruptor y servicios son opcionales", () => {
  const ms = [{ stamps: 8, title: "Corte gratis", rewardType: "service_free" as const }];
  const common = { milestones: ms, cardTitle: "VIP", brandColor: "#111827" };
  it("sin enviarlos, el servidor deja lo que había", () => {
    const r = loyaltySettingsInputSchema.parse(common);
    expect(r.enabled).toBeUndefined();
    expect(r.eligibleServiceIds).toBeUndefined();
  });
  it("con ellos los respeta", () => {
    const r = loyaltySettingsInputSchema.parse({ ...common, enabled: false, eligibleServiceIds: ["a", "a"] });
    expect(r.enabled).toBe(false);
    expect(r.eligibleServiceIds).toEqual(["a"]);
  });
});

describe("tarjeta de fidelización: un sello por monto mínimo", () => {
  it("una venta que iguala o supera el mínimo da 1 sello, sin importar el servicio", () => {
    expect(saleEarnsStamp(2500, 2500)).toBe(true); // corte básico
    expect(saleEarnsStamp(2500, 8000)).toBe(true); // limpieza facial
    expect(saleEarnsStamp(2500, 18000)).toBe(true); // tinte
  });
  it("una venta por debajo del mínimo no da sello", () => {
    expect(saleEarnsStamp(2500, 2499)).toBe(false);
    expect(saleEarnsStamp(2500, 1000)).toBe(false);
  });
  it("mínimo 0 = cualquier venta suma", () => {
    expect(saleEarnsStamp(0, 100)).toBe(true);
  });
  it("el monto mínimo se valida: entero, no negativo", () => {
    const base = { milestones: [{ stamps: 4, rewardType: "service_free" as const }], cardTitle: "VIP", brandColor: "#111827" };
    expect(loyaltySettingsInputSchema.safeParse({ ...base, minStampAmountCents: 2500 }).success).toBe(true);
    expect(loyaltySettingsInputSchema.safeParse({ ...base, minStampAmountCents: -1 }).success).toBe(false);
    expect(loyaltySettingsInputSchema.safeParse({ ...base, minStampAmountCents: 12.5 }).success).toBe(false);
    expect(loyaltySettingsInputSchema.parse(base).minStampAmountCents).toBeUndefined();
  });
});
