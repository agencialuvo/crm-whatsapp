import { describe, expect, it, vi } from "vitest";
import type { PickerNode } from "@/lib/ad-picker";
import {
  adReferralDedupeKey,
  adReferralDedupeKeyFor,
  adScopeOf,
  matchesAdTrigger,
  parseAdReferralConfig,
} from "@/lib/automation";
import { parseTriggerConfigFor } from "@/lib/automation-schemas";
import { describeAdTrigger, describeTrigger } from "@/lib/automation-dto";
import { emitAdReferral } from "@/server/automation/ad-referral";
import type { EnqueueInput, FlowRef, TriggerStore } from "@/server/automation/trigger-store";

/**
 * 047 — El disparador «Llegó de un anuncio» por anuncio, conjunto o campaña: la regla de coincidencia, el contrato
 * de la configuración (compatible con los flujos de hoy), las llaves de idempotencia y el nombre vivo en pantalla.
 */

const ad = { adId: "AD1", adsetId: "AS1", campaignId: "CP1" };

describe("parseAdReferralConfig — retrocompatible", () => {
  it.each([
    [null, {}],
    [undefined, {}],
    [{}, {}],
    [{ sourceId: "AD1" }, { sourceId: "AD1" }],
    [{ sourceId: "  AD1  " }, { sourceId: "AD1" }],
    [{ sourceId: "" }, {}],
    [{ sourceId: 5 }, {}],
    [{ adsetId: "AS1" }, { adsetId: "AS1" }],
    [{ campaignId: "CP1" }, { campaignId: "CP1" }],
    // un dato hecho a mano con varias claves: manda la más específica
    [{ sourceId: "AD1", adsetId: "AS1", campaignId: "CP1" }, { sourceId: "AD1" }],
    [{ adsetId: "AS1", campaignId: "CP1" }, { adsetId: "AS1" }],
  ])("%j → %j", (raw, expected) => expect(parseAdReferralConfig(raw)).toEqual(expected));

  it("adScopeOf", () => {
    expect(adScopeOf({})).toEqual({ level: "any", id: null });
    expect(adScopeOf({ sourceId: "A" })).toEqual({ level: "ad", id: "A" });
    expect(adScopeOf({ adsetId: "S" })).toEqual({ level: "adset", id: "S" });
    expect(adScopeOf({ campaignId: "C" })).toEqual({ level: "campaign", id: "C" });
  });
});

describe("matchesAdTrigger", () => {
  it.each([
    ["cualquiera", {}, ad, "yes"],
    ["por anuncio igual", { sourceId: "AD1" }, ad, "yes"],
    ["por anuncio distinto", { sourceId: "AD2" }, ad, "no"],
    ["por conjunto igual", { adsetId: "AS1" }, ad, "yes"],
    ["por conjunto distinto", { adsetId: "AS2" }, ad, "no"],
    ["por campaña igual", { campaignId: "CP1" }, ad, "yes"],
    ["por campaña distinta", { campaignId: "CP2" }, ad, "no"],
    // jerarquía aún desconocida (primer mensaje de un anuncio nuevo)
    ["conjunto sin jerarquía", { adsetId: "AS1" }, { adId: "AD1" }, "unknown"],
    ["campaña sin jerarquía", { campaignId: "CP1" }, { adId: "AD1", adsetId: null, campaignId: null }, "unknown"],
    // por anuncio y cualquiera NO dependen de la jerarquía
    ["anuncio sin jerarquía", { sourceId: "AD1" }, { adId: "AD1" }, "yes"],
    ["cualquiera sin jerarquía", {}, { adId: "AD9" }, "yes"],
    // conocida la campaña pero no el conjunto
    ["conjunto con solo campaña conocida", { adsetId: "AS1" }, { adId: "AD1", campaignId: "CP1" }, "unknown"],
  ] as const)("%s", (_n, cfg, hierarchy, out) => expect(matchesAdTrigger(cfg, hierarchy)).toBe(out));
});

describe("llaves de idempotencia", () => {
  it("por anuncio y cualquiera: la de siempre", () => {
    expect(adReferralDedupeKey("AD1")).toBe("ad_referral:AD1");
    expect(adReferralDedupeKeyFor({}, "AD1")).toBe("ad_referral:AD1");
    expect(adReferralDedupeKeyFor({ sourceId: "AD1" }, "AD1")).toBe("ad_referral:AD1");
  });
  it("por conjunto o campaña: por ALCANCE, igual para dos anuncios de lo mismo", () => {
    expect(adReferralDedupeKeyFor({ campaignId: "CP1" }, "AD1")).toBe("ad_referral:campaign:CP1");
    expect(adReferralDedupeKeyFor({ campaignId: "CP1" }, "AD2")).toBe("ad_referral:campaign:CP1");
    expect(adReferralDedupeKeyFor({ adsetId: "AS1" }, "AD1")).toBe("ad_referral:adset:AS1");
  });
});

describe("contrato Zod del disparador", () => {
  const ok = (v: unknown) => parseTriggerConfigFor("ad_referral", v);
  it("los flujos de hoy siguen válidos", () => {
    expect(ok(undefined)).toEqual({ ok: true, value: null });
    expect(ok({})).toEqual({ ok: true, value: null });
    expect(ok({ sourceId: "123" })).toEqual({ ok: true, value: { sourceId: "123" } });
    expect(ok({ sourceId: null })).toEqual({ ok: true, value: null });
  });
  it("acepta conjunto y campaña, uno a la vez", () => {
    expect(ok({ adsetId: "AS1" })).toEqual({ ok: true, value: { adsetId: "AS1" } });
    expect(ok({ campaignId: "CP1" })).toEqual({ ok: true, value: { campaignId: "CP1" } });
  });
  it("rechaza varias claves, claves desconocidas (nombres) y vacíos/largos", () => {
    expect(ok({ sourceId: "A", campaignId: "C" }).ok).toBe(false);
    expect(ok({ adsetId: "S", campaignId: "C" }).ok).toBe(false);
    expect(ok({ campaignName: "Verano" }).ok).toBe(false); // nunca nombres
    expect(ok({ campaignId: "" }).ok).toBe(false);
    expect(ok({ adsetId: "x".repeat(201) }).ok).toBe(false);
  });
});

describe("el nombre vivo en pantalla", () => {
  const camp: PickerNode = { level: "campaign", id: "CP1", name: "Verano", adsetCount: 2, adCount: 7, active: true };
  const set: PickerNode = { level: "adset", id: "AS1", name: "Lima", campaignId: "CP1", campaignName: "Verano", adCount: 3, active: true };
  const adn: PickerNode = { level: "ad", id: "AD1", name: "Promo mayo", adsetId: "AS1", adsetName: "Lima", campaignId: "CP1", campaignName: "Verano", status: "ACTIVE", thumbUrl: null };

  it("cualquiera, anuncio, conjunto y campaña", () => {
    expect(describeAdTrigger({}, null)).toBe("Cuando alguien llega de cualquier anuncio");
    expect(describeAdTrigger({ sourceId: "AD1" }, adn)).toBe("Cuando alguien llega del anuncio «Promo mayo» (Verano › Lima)");
    expect(describeAdTrigger({ adsetId: "AS1" }, set)).toBe("Cuando alguien llega de cualquier anuncio del conjunto «Lima» (campaña Verano)");
    expect(describeAdTrigger({ campaignId: "CP1" }, camp)).toBe("Cuando alguien llega de cualquier anuncio de la campaña «Verano»");
  });
  it("un renombre en Meta se refleja al instante: el texto sale del nodo, no del flujo", () => {
    const renombrado = { ...camp, name: "Verano 2027" } as PickerNode;
    expect(describeAdTrigger({ campaignId: "CP1" }, renombrado)).toContain("«Verano 2027»");
  });
  it("sin catálogo se muestra el ID y se dice", () => {
    expect(describeAdTrigger({ campaignId: "CP9" }, null)).toBe("Cuando alguien llega de cualquier anuncio de la campaña CP9 (aún sin sincronizar desde Meta)");
    expect(describeTrigger("ad_referral", { adsetId: "AS9" })).toContain("AS9");
  });
});

/* ─── emitAdReferral con dobles ─── */

const flow = (id: string, triggerConfig: unknown = null): FlowRef => ({ id, organizationId: "org_1", triggerConfig });
function fakeStore(flows: FlowRef[]) {
  const calls: EnqueueInput[] = [];
  const store: TriggerStore = {
    activeFlows: vi.fn(async () => flows),
    hasRealConversation: vi.fn(async () => true),
    enqueueFirstStep: vi.fn(async (i: EnqueueInput) => {
      calls.push(i);
      return true;
    }),
  } as unknown as TriggerStore;
  return { store, calls };
}
const input = { organizationId: "org_1", contactId: "ct_1", sourceId: "AD1", headline: null };
const ctx = vi.fn(async () => ({ adSourceId: "AD1" }));
const known = vi.fn(async () => ({ adId: "AD1", adsetId: "AS1", campaignId: "CP1" }));
const unknown = vi.fn(async () => ({ adId: "AD1", adsetId: null, campaignId: null }));

describe("emitAdReferral con alcance", () => {
  it("con la jerarquía conocida arranca los de anuncio, conjunto, campaña y cualquiera; no los ajenos", async () => {
    const t = fakeStore([
      flow("anuncio", { sourceId: "AD1" }),
      flow("conjunto", { adsetId: "AS1" }),
      flow("campania", { campaignId: "CP1" }),
      flow("cualquiera"),
      flow("otra-campania", { campaignId: "CP2" }),
      flow("otro-anuncio", { sourceId: "AD2" }),
    ]);
    expect(await emitAdReferral(input, t.store, () => true, ctx, () => new Date(), known)).toBe(4);
    expect(t.calls.map((c) => c.flowId)).toEqual(["anuncio", "conjunto", "campania", "cualquiera"]);
  });

  it("cada flujo lleva SU llave: por alcance en conjunto/campaña, por anuncio en el resto", async () => {
    const t = fakeStore([flow("anuncio", { sourceId: "AD1" }), flow("conjunto", { adsetId: "AS1" }), flow("campania", { campaignId: "CP1" })]);
    await emitAdReferral(input, t.store, () => true, ctx, () => new Date(), known);
    expect(Object.fromEntries(t.calls.map((c) => [c.flowId, c.dedupeKey]))).toEqual({
      anuncio: "ad_referral:AD1",
      conjunto: "ad_referral:adset:AS1",
      campania: "ad_referral:campaign:CP1",
    });
  });

  it("con la jerarquía DESCONOCIDA los de conjunto/campaña esperan; los de anuncio y cualquiera arrancan ya", async () => {
    const t = fakeStore([flow("anuncio", { sourceId: "AD1" }), flow("conjunto", { adsetId: "AS1" }), flow("campania", { campaignId: "CP1" }), flow("cualquiera")]);
    expect(await emitAdReferral(input, t.store, () => true, ctx, () => new Date(), unknown)).toBe(2);
    expect(t.calls.map((c) => c.flowId)).toEqual(["anuncio", "cualquiera"]);
  });

  it("un flujo viejo con { sourceId } sigue funcionando sin tocarlo", async () => {
    const t = fakeStore([flow("viejo", { sourceId: "AD1" })]);
    expect(await emitAdReferral(input, t.store, () => true, ctx, () => new Date(), unknown)).toBe(1);
  });

  it("nunca lanza si el catálogo falla", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = fakeStore([flow("campania", { campaignId: "CP1" })]);
    expect(await emitAdReferral(input, t.store, () => true, ctx, () => new Date(), vi.fn(async () => Promise.reject(new Error("db")))) ).toBe(0);
    err.mockRestore();
  });
});
