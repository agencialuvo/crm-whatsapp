import { describe, expect, it } from "vitest";
import {
  buildAccountPath,
  buildAdsListPath,
  buildPixelsPath,
  buildSpendPath,
  parseAccountInsights,
  parseAdsPage,
  parseInsightsPage,
  parsePixels,
} from "@/lib/meta/ads";
import { cuadrarCuenta, estadoDeAnuncio, estadoDeGrupo, rate, type AdRowDto } from "@/lib/analytics";
import {
  armarJerarquia,
  mismoHuso,
  totalDeFilas,
  type CatalogEntry,
  type FilaConInstante,
} from "@/server/analytics/ads-hierarchy";

/** 039 — Catálogo completo de Meta, navegación por clic y cuadre de la cuenta. Todo puro: sin red ni base. */

const q = (path: string) => new URL(`http://x/${path}`).searchParams;

describe("consultas de la cuenta completa", () => {
  it("el listado de la cuenta NO filtra por ids, pide el estado efectivo y pagina por `after`", () => {
    const p = q(buildAdsListPath("act_1"));
    expect(p.get("filtering")).toBeNull();
    expect(p.get("fields")).toBe("id,name,effective_status,adset{id,name},campaign{id,name}");
    expect(p.get("limit")).toBe("200");
    expect(p.has("after")).toBe(false);
    expect(q(buildAdsListPath("act_1", "CUR=")).get("after")).toBe("CUR=");
    expect(buildAdsListPath("act_9")).toMatch(/^act_9\/ads\?/);
  });

  it("el gasto por anuncio no lleva filtro de ids y trae la jerarquía en los campos", () => {
    const p = q(buildSpendPath("act_1", "ad", "2026-11-01", "2026-11-07"));
    expect(p.get("level")).toBe("ad");
    expect(p.get("filtering")).toBeNull();
    expect(p.get("fields")).toBe("ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,account_currency");
    expect(p.get("time_increment")).toBe("1");
    expect(JSON.parse(p.get("time_range")!)).toEqual({ since: "2026-11-01", until: "2026-11-07" });
  });

  it("el gasto de la cuenta es level=account, solo spend y moneda", () => {
    const p = q(buildSpendPath("act_1", "account", "2026-11-01", "2026-11-07", "AFTER"));
    expect(p.get("level")).toBe("account");
    expect(p.get("fields")).toBe("spend,account_currency");
    expect(p.get("after")).toBe("AFTER");
  });

  it("validar la cuenta también pide su zona horaria; los datasets salen de adspixels", () => {
    expect(q(buildAccountPath("act_1")).get("fields")).toBe("name,currency,account_status,timezone_name");
    expect(buildPixelsPath("act_1")).toMatch(/^act_1\/adspixels\?/);
  });
});

describe("lectura de respuestas", () => {
  it("parseAdsPage conserva el estado efectivo", () => {
    const { ads } = parseAdsPage({
      data: [
        { id: "1", name: "A", effective_status: "CAMPAIGN_PAUSED", adset: { id: "s", name: "S" }, campaign: { id: "c", name: "C" } },
        { id: "2", name: "B" },
      ],
    });
    expect(ads[0]!.effectiveStatus).toBe("CAMPAIGN_PAUSED");
    expect(ads[1]!.effectiveStatus).toBeNull();
  });

  it("el gasto trae la jerarquía de cada fila (así un anuncio borrado que gastó queda con nombre)", () => {
    const { rows } = parseInsightsPage({
      data: [
        {
          ad_id: "9", ad_name: "Borrado", adset_id: "s", adset_name: "Conj", campaign_id: "c", campaign_name: "Camp",
          spend: "7.00", account_currency: "MXN", date_start: "2026-11-02",
        },
        { ad_id: "10", spend: "1.00", account_currency: "MXN", date_start: "2026-11-02" },
      ],
    });
    expect(rows[0]!.node).toMatchObject({ adId: "9", adName: "Borrado", adsetName: "Conj", campaignName: "Camp" });
    // Sin ningún nombre no se inventa un nodo vacío.
    expect(rows[1]!.node).toBeUndefined();
  });

  it("el gasto de la cuenta se lee por día y descarta filas rotas", () => {
    const { rows } = parseAccountInsights({
      data: [
        { spend: "12.5", account_currency: "MXN", date_start: "2026-11-01" },
        { spend: "", account_currency: "MXN", date_start: "2026-11-02" },
        { spend: "3", account_currency: "MXN", date_start: "mañana" },
        { spend: "3", date_start: "2026-11-04" },
        null,
      ],
    });
    expect(rows).toEqual([{ day: "2026-11-01", spend: "12.50", currency: "MXN" }]);
  });

  it("parsePixels acepta solo ids numéricos y nombra con el id si no hay nombre", () => {
    expect(parsePixels({ data: [{ id: "123", name: "Dataset" }, { id: "456" }, { id: "abc", name: "x" }, null] })).toEqual([
      { id: "123", name: "Dataset" },
      { id: "456", name: "456" },
    ]);
    expect(parsePixels(null)).toEqual([]);
  });
});

describe("estado en Meta", () => {
  it("simplifica effective_status", () => {
    expect(estadoDeAnuncio("ACTIVE")).toBe("active");
    for (const e of ["PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"]) expect(estadoDeAnuncio(e)).toBe("paused");
    for (const e of ["ARCHIVED", "DELETED"]) expect(estadoDeAnuncio(e)).toBe("archived");
    for (const e of ["WITH_ISSUES", "IN_PROCESS", "", null, undefined]) expect(estadoDeAnuncio(e)).toBeNull();
  });

  it("un grupo toma el estado de sus anuncios si coinciden y es «mixed» si no; ignora los desconocidos", () => {
    expect(estadoDeGrupo(["paused", "paused"])).toBe("paused");
    expect(estadoDeGrupo(["paused", null, "paused"])).toBe("paused");
    expect(estadoDeGrupo(["active", "paused"])).toBe("mixed");
    expect(estadoDeGrupo([null, null])).toBeNull();
    expect(estadoDeGrupo([])).toBeNull();
  });
});

describe("cuadrar la cuenta contra lo desglosado", () => {
  it("cuadra al centavo: no hay nada sin desglosar", () => {
    expect(cuadrarCuenta(100, 100)).toEqual({ spend: 100, unattributed: null });
    expect(cuadrarCuenta(100.004, 100)).toEqual({ spend: 100, unattributed: null });
  });
  it("la diferencia positiva es gasto que ningún anuncio explica", () => {
    expect(cuadrarCuenta(120.5, 100)).toEqual({ spend: 120.5, unattributed: 20.5 });
  });
  it("una diferencia negativa también se dice (lo desglosado supera a la cuenta)", () => {
    expect(cuadrarCuenta(90, 100)).toEqual({ spend: 90, unattributed: -10 });
  });
  it("redondea la diferencia a centavos", () => {
    expect(cuadrarCuenta(0.3, 0.1 + 0.1)).toEqual({ spend: 0.3, unattributed: 0.1 });
  });
  it("sin datos de la cuenta no se inventa un cuadre", () => {
    expect(cuadrarCuenta(null, 50)).toBeNull();
    expect(cuadrarCuenta(Number.NaN, 50)).toBeNull();
  });
});

describe("zona horaria", () => {
  const at = new Date("2026-11-15T12:00:00Z");
  it("misma zona o mismo huso es la misma", () => {
    expect(mismoHuso("America/Mexico_City", "America/Mexico_City", at)).toBe(true);
    expect(mismoHuso("America/Mexico_City", "America/Monterrey", at)).toBe(true);
  });
  it("otro huso es otra", () => {
    expect(mismoHuso("America/Mexico_City", "Europe/Madrid", at)).toBe(false);
  });
  it("una zona inválida no rompe: se asume que coincide (no se avisa de lo que no se sabe)", () => {
    expect(mismoHuso("Marte/Olimpo", "America/Mexico_City", at)).toBe(true);
  });
});

/* ── La jerarquía con cuenta completa ─────────────────────────── */

const fila = (key: string, over: Partial<FilaConInstante> = {}): FilaConInstante => ({
  key, sourceId: key, sourceType: "ad", headline: null, imageAssetId: null,
  conversations: 0, leads: 0, won: 0, winRate: rate(0, 0), lastAt: 0, ...over,
});
const cat = (adId: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  adId, adName: `Anuncio ${adId}`, adsetId: "s1", adsetName: "Conjunto 1", campaignId: "c1", campaignName: "Campaña 1", effectiveStatus: "ACTIVE", ...over,
});

describe("cuenta completa en Resultados", () => {
  it("una campaña pausada con gasto y SIN conversaciones aparece, con su estado", () => {
    const out = armarJerarquia({
      rows: [fila("a1", { conversations: 3, leads: 2, won: 1 })],
      catalog: new Map([
        ["a1", cat("a1")],
        ["b1", cat("b1", { adsetId: "s9", adsetName: "Conjunto Beta", campaignId: "c9", campaignName: "Beta pausada", effectiveStatus: "CAMPAIGN_PAUSED" })],
      ]),
      spend: new Map([
        ["a1", { amount: 20, currencies: ["MXN"] }],
        ["b1", { amount: 30, currencies: ["MXN"] }],
      ]),
      bookings: null,
      query: { group: "campaign", campaignId: null, adsetId: null },
      maxAds: 50,
    });
    const beta = out.groups.find((g) => g.key === "c9")!;
    expect(beta).toMatchObject({ name: "Beta pausada", conversations: 0, spend: 30, status: "paused", costPerConversation: null });
    expect(out.groups.find((g) => g.key === "c1")).toMatchObject({ spend: 20, status: "active", costPerConversation: 6.67 });
    // El total cuenta TODAS las filas, también la que no trajo a nadie.
    expect(out.total).toMatchObject({ ads: 2, conversations: 3, spend: 50 });
  });

  it("las filas de conjunto llevan el id de su campaña (con él un clic sabe de cuál viene)", () => {
    const out = armarJerarquia({
      rows: [fila("a1", { conversations: 1 })],
      catalog: new Map([["a1", cat("a1")]]),
      spend: new Map(),
      bookings: null,
      query: { group: "adset", campaignId: null, adsetId: null },
      maxAds: 50,
    });
    expect(out.groups[0]).toMatchObject({ key: "s1", level: "adset", campaignId: "c1", campaignName: "Campaña 1" });
  });

  it("un grupo con anuncios activos y pausados es «mixed»", () => {
    const out = armarJerarquia({
      rows: [fila("a1", { conversations: 1 }), fila("a2", { conversations: 1 })],
      catalog: new Map([["a1", cat("a1")], ["a2", cat("a2", { effectiveStatus: "PAUSED" })]]),
      spend: new Map(),
      bookings: null,
      query: { group: "campaign", campaignId: null, adsetId: null },
      maxAds: 50,
    });
    expect(out.groups[0]!.status).toBe("mixed");
  });

  it("el filtro por campaña deja solo los conjuntos de esa campaña", () => {
    const out = armarJerarquia({
      rows: [fila("a1", { conversations: 1 }), fila("a2", { conversations: 1 })],
      catalog: new Map([["a1", cat("a1")], ["a2", cat("a2", { campaignId: "c2", campaignName: "Otra", adsetId: "s2", adsetName: "Otro" })]]),
      spend: new Map(),
      bookings: null,
      query: { group: "adset", campaignId: "c1", adsetId: null },
      maxAds: 50,
    });
    expect(out.groups.map((g) => g.key)).toEqual(["s1"]);
    expect(out.total.ads).toBe(1);
  });

  it("la lista se recorta pero el total no", () => {
    const rows = Array.from({ length: 5 }, (_, i) => fila(`a${i}`, { conversations: 5 - i, leads: 1 }));
    const catalog = new Map(rows.map((r) => [r.key, cat(r.key)]));
    const spend = new Map(rows.map((r) => [r.key, { amount: 10, currencies: ["MXN"] }]));
    const out = armarJerarquia({ rows, catalog, spend, bookings: null, query: { group: "ad", campaignId: null, adsetId: null }, maxAds: 2 });
    expect(out.ads).toHaveLength(2);
    expect(out.total).toMatchObject({ ads: 5, conversations: 15, leads: 5, spend: 50, costPerConversation: 3.33 });
  });
});

describe("total del pie", () => {
  it("suma conteos y calcula costos solo sobre las filas con gasto conocido", () => {
    const t = totalDeFilas(
      [
        { conversations: 10, leads: 5, won: 1, bookings: 2, spend: 100 },
        { conversations: 30, leads: 10, won: 2, bookings: 1, spend: null },
      ],
      true
    );
    expect(t).toMatchObject({ ads: 2, conversations: 40, leads: 15, won: 3, bookings: 3, spend: 100 });
    // El denominador es el de la fila CON gasto (10), no el de todas (40): si no, el costo saldría más barato.
    expect(t.costPerConversation).toBe(10);
    expect(t.costPerLead).toBe(20);
    expect(t.costPerBooking).toBe(50);
  });

  it("sin gasto en ninguna fila, todo costo es null; sin agenda no hay citas", () => {
    const t = totalDeFilas([{ conversations: 4, leads: 1, won: 0, bookings: null }], false);
    expect(t).toMatchObject({ spend: null, costPerConversation: null, costPerLead: null, costPerBooking: null, bookings: null });
  });

  it("con gasto y cero resultados el costo es null, no infinito", () => {
    const t = totalDeFilas([{ conversations: 0, leads: 0, won: 0, bookings: 0, spend: 40 }], true);
    expect(t.spend).toBe(40);
    expect(t.costPerConversation).toBeNull();
  });

  it("filas vacías: total en cero", () => {
    expect(totalDeFilas([], false)).toMatchObject({ ads: 0, conversations: 0, spend: null });
  });
});

// Mantener el tipo importado vivo para que un cambio de la fila de anuncio rompa esta prueba y no pase en silencio.
const _tipo: Pick<AdRowDto, "status"> = { status: "paused" };
void _tipo;
