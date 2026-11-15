import { describe, expect, it } from "vitest";
import {
  buildAdsPath,
  buildInsightsPath,
  chunk,
  classifyGraphError,
  normalizeAdAccountId,
  normalizeSpend,
  parseAdsPage,
  parseInsightsPage,
  parseUsageHeaders,
  rateLimitBackoffMs,
  sanitizeError,
  transientBackoffMs,
} from "@/lib/meta/ads";
import { MetaApiError } from "@/lib/meta/client";
import { costOf, type AdRowDto } from "@/lib/analytics";
import {
  armarJerarquia,
  SIN_IDENTIFICAR,
  type CatalogEntry,
  type FilaConInstante,
  type HierarchyInput,
} from "@/server/analytics/ads-hierarchy";
import { rate } from "@/lib/analytics";

/** 038 — La parte pura del conector de la Marketing API y la jerarquía de Resultados. Sin red ni base. */

const err = (status: number, code: number | null, message = "x") => new MetaApiError(message, { status, code });
const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });

describe("normalizeAdAccountId", () => {
  it.each([
    ["act_1234567890", "act_1234567890"],
    ["1234567890", "act_1234567890"],
    ["  ACT_1234567890 ", "act_1234567890"],
    ["act-123 456 7890", "act_1234567890"],
    ["123-456-7890", "act_1234567890"],
  ])("%s → %s", (input, out) => expect(normalizeAdAccountId(input)).toBe(out));

  it.each(["", "abc", "act_", "12", "act_12ab34", "1234567890123456789012"])("rechaza «%s»", (input) =>
    expect(normalizeAdAccountId(input)).toBeNull()
  );
});

describe("classifyGraphError", () => {
  it.each([
    [err(401, 190), "auth"],
    [err(400, 190), "auth"],
    [err(400, 102), "auth"],
    [err(403, 10), "permission"],
    [err(403, 200), "permission"],
    [err(403, 299), "permission"],
    [err(400, 4), "rate_limit"],
    [err(400, 17), "rate_limit"],
    [err(400, 32), "rate_limit"],
    [err(400, 613), "rate_limit"],
    [err(400, 80000), "rate_limit"],
    [err(400, 80004), "rate_limit"],
    [err(400, 80014), "rate_limit"],
    [err(500, 2), "transient"],
    [err(503, null), "transient"],
    [err(0, null), "transient"],
    [err(400, 1), "transient"],
    [err(400, 100), "permanent"],
    [err(404, null), "permanent"],
  ] as const)("%o → %s", (e, kind) => expect(classifyGraphError(e).kind).toBe(kind));

  it("un 5xx con código 190 NO es un token inválido (Meta etiqueta así errores transitorios)", () => {
    expect(classifyGraphError(err(500, 190)).kind).toBe("transient");
  });

  it("el límite de uso gana al resto: un 17 nunca se confunde con permisos", () => {
    expect(classifyGraphError(err(403, 17)).kind).toBe("rate_limit");
  });

  it("un error que no es de Meta (red, bug) es transitorio, no permanente", () => {
    expect(classifyGraphError(new Error("boom")).kind).toBe("transient");
    expect(classifyGraphError("raro").kind).toBe("transient");
  });
});

describe("sanitizeError", () => {
  it("quita tokens de la URL, Bearer y cadenas largas", () => {
    const token = "EAABsbCS1iHgBO" + "x".repeat(40);
    const out = sanitizeError(`fallo en ?access_token=${token}&x=1 con Bearer ${token} y ${token}`);
    expect(out).not.toContain(token);
    expect(out).not.toContain("EAABsbCS1iHgBO");
    expect(out).toContain("[oculto]");
  });

  it("acota la longitud", () => {
    expect(sanitizeError("a ".repeat(500)).length).toBeLessThanOrEqual(300);
  });

  it("deja intacto un mensaje normal", () => {
    expect(sanitizeError("(#17) User request limit reached")).toBe("(#17) User request limit reached");
  });
});

describe("esperas", () => {
  it("transitorio: 1 min → 5 → 30 → 2 h → 6 h y se queda en el tope", () => {
    const min = 60_000;
    expect([1, 2, 3, 4, 5, 6, 9].map(transientBackoffMs)).toEqual([min, 5 * min, 30 * min, 120 * min, 360 * min, 360 * min, 360 * min]);
  });

  it("transitorio: un número de intento absurdo no rompe", () => {
    expect(transientBackoffMs(0)).toBe(60_000);
    expect(transientBackoffMs(-3)).toBe(60_000);
  });

  it("límite de uso: 5 → 10 → 20 → … tope 120 min", () => {
    const min = 60_000;
    expect([1, 2, 3, 4, 5, 6, 20].map(rateLimitBackoffMs)).toEqual([5 * min, 10 * min, 20 * min, 40 * min, 80 * min, 120 * min, 120 * min]);
  });
});

describe("parseUsageHeaders", () => {
  it("toma el indicador más alto de x-business-use-case-usage y el tiempo de espera", () => {
    const u = parseUsageHeaders(
      headers({
        "x-business-use-case-usage": JSON.stringify({ "123": [{ call_count: 40, total_cputime: 92, total_time: 10, estimated_time_to_regain_access: 7 }] }),
      })
    );
    expect(u.maxPct).toBe(92);
    expect(u.regainMs).toBe(7 * 60_000);
  });

  it("combina x-app-usage", () => {
    expect(parseUsageHeaders(headers({ "x-app-usage": JSON.stringify({ call_count: 96 }) })).maxPct).toBe(96);
  });

  it("sin cabeceras o con basura: sin dato, sin lanzar", () => {
    expect(parseUsageHeaders(headers({}))).toEqual({ maxPct: 0, regainMs: null });
    expect(parseUsageHeaders(headers({ "x-app-usage": "{no es json", "x-business-use-case-usage": "[[" }))).toEqual({ maxPct: 0, regainMs: null });
    expect(parseUsageHeaders(headers({ "x-app-usage": JSON.stringify({ call_count: "mucho" }) })).maxPct).toBe(0);
  });
});

describe("consultas", () => {
  it("la de anuncios filtra por id dentro de la cuenta, con jerarquía y límite", () => {
    const path = buildAdsPath("act_1", ["a1", "a2"]);
    expect(path.startsWith("act_1/ads?")).toBe(true);
    const q = new URL(`http://x/${path}`).searchParams;
    expect(q.get("fields")).toBe("id,name,adset{id,name},campaign{id,name}");
    expect(JSON.parse(q.get("filtering")!)).toEqual([{ field: "id", operator: "IN", value: ["a1", "a2"] }]);
    expect(q.get("limit")).toBe("50");
  });

  it("la de gasto pide nivel anuncio, día a día, con el rango y el cursor", () => {
    const q = new URL(`http://x/${buildInsightsPath("act_1", ["a1"], "2026-11-01", "2026-11-07", "CURSOR=")}`).searchParams;
    expect(q.get("level")).toBe("ad");
    expect(q.get("time_increment")).toBe("1");
    expect(JSON.parse(q.get("time_range")!)).toEqual({ since: "2026-11-01", until: "2026-11-07" });
    expect(JSON.parse(q.get("filtering")!)).toEqual([{ field: "ad.id", operator: "IN", value: ["a1"] }]);
    expect(q.get("after")).toBe("CURSOR=");
    expect(new URL(`http://x/${buildInsightsPath("act_1", ["a1"], "2026-11-01", "2026-11-07")}`).searchParams.has("after")).toBe(false);
  });

  it("chunk parte en lotes sin perder ni repetir", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 50)).toEqual([]);
    const ids = Array.from({ length: 120 }, (_, i) => i);
    expect(chunk(ids, 50).map((l) => l.length)).toEqual([50, 50, 20]);
  });
});

describe("respuestas", () => {
  it("parseAdsPage lee jerarquía, ignora basura y recorta", () => {
    const { ads } = parseAdsPage({
      data: [
        { id: "1", name: " Anuncio uno ", adset: { id: "10", name: "Conjunto" }, campaign: { id: "100", name: "Campaña" } },
        { id: "2", name: "Sin jerarquía" },
        { id: "", name: "sin id" },
        null,
        "texto",
        { id: 3, name: "id numérico" },
      ],
    });
    expect(ads).toEqual([
      { adId: "1", adName: "Anuncio uno", adsetId: "10", adsetName: "Conjunto", campaignId: "100", campaignName: "Campaña" },
      { adId: "2", adName: "Sin jerarquía", adsetId: null, adsetName: null, campaignId: null, campaignName: null },
    ]);
  });

  it("parseAdsPage con formas rotas devuelve vacío sin lanzar", () => {
    for (const x of [null, undefined, "x", 3, [], {}, { data: "no" }]) expect(parseAdsPage(x).ads).toEqual([]);
  });

  it("parseInsightsPage lee el gasto diario y el cursor solo si hay página siguiente", () => {
    const page = parseInsightsPage({
      data: [
        { ad_id: "1", spend: "12.5", account_currency: "MXN", date_start: "2026-11-01" },
        { ad_id: "1", spend: "0", account_currency: "MXN", date_start: "2026-11-02" },
        { ad_id: "2", spend: "abc", account_currency: "MXN", date_start: "2026-11-02" },
        { ad_id: "2", spend: "5", account_currency: "MXN", date_start: "mañana" },
        { ad_id: "2", spend: "5", date_start: "2026-11-02" },
        { ad_id: "2", spend: "-5", account_currency: "MXN", date_start: "2026-11-02" },
      ],
      paging: { cursors: { after: "NEXT" }, next: "https://graph/…" },
    });
    expect(page.rows).toEqual([
      { adId: "1", day: "2026-11-01", spend: "12.50", currency: "MXN" },
      { adId: "1", day: "2026-11-02", spend: "0.00", currency: "MXN" },
    ]);
    expect(page.after).toBe("NEXT");
    // Meta manda `cursors` aun en la última página: sin `next` no hay más.
    expect(parseInsightsPage({ data: [], paging: { cursors: { after: "X" } } }).after).toBeNull();
  });

  it("normalizeSpend: dos decimales, rechaza lo que no es un importe", () => {
    expect(normalizeSpend("12.345")).toBe("12.35");
    expect(normalizeSpend(7)).toBe("7.00");
    for (const x of ["", "abc", "-1", null, undefined, {}, Infinity, "1e99"]) expect(normalizeSpend(x)).toBeNull();
  });
});

describe("costOf", () => {
  it("redondea a dos decimales", () => expect(costOf(100, 3)).toBe(33.33));
  it("sin gasto o sin resultados no hay costo (nunca un 0 que parezca dato)", () => {
    expect(costOf(null, 5)).toBeNull();
    expect(costOf(undefined, 5)).toBeNull();
    expect(costOf(100, 0)).toBeNull();
    expect(costOf(100, null)).toBeNull();
    expect(costOf(NaN, 2)).toBeNull();
  });
  it("un gasto de 0 con resultados SÍ es un costo de 0", () => expect(costOf(0, 4)).toBe(0));
});

/* ── La jerarquía de Resultados ─────────────────────────────────── */

function fila(key: string, over: Partial<FilaConInstante> = {}): FilaConInstante {
  return {
    key,
    sourceId: key,
    sourceType: "ad",
    headline: `Titular ${key}`,
    imageAssetId: null,
    conversations: 0,
    leads: 0,
    won: 0,
    winRate: rate(0, 0),
    lastAt: 1,
    ...over,
  };
}

const cat = (adId: string, campaign: string | null, adset: string | null): CatalogEntry => ({
  adId,
  adName: `Nombre ${adId}`,
  adsetId: adset ? `as-${adset}` : null,
  adsetName: adset ? `Conjunto ${adset}` : null,
  campaignId: campaign ? `c-${campaign}` : null,
  campaignName: campaign ? `Campaña ${campaign}` : null,
});

function input(over: Partial<HierarchyInput> = {}): HierarchyInput {
  return {
    rows: [],
    catalog: new Map(),
    spend: new Map(),
    bookings: null,
    query: { group: "ad", campaignId: null, adsetId: null },
    maxAds: 50,
    ...over,
  };
}

const gasto = (amount: number, currency = "MXN") => ({ amount, currencies: [currency] });

describe("armarJerarquia", () => {
  it("un anuncio con gasto y CERO conversaciones aparece (es el dinero tirado)", () => {
    const out = armarJerarquia(
      input({
        rows: [fila("a1", { conversations: 4, leads: 2 })],
        catalog: new Map([["a2", cat("a2", "1", "1")]]),
        spend: new Map([["a2", gasto(300)]]),
      })
    );
    const sinGente = out.ads.find((a) => a.key === "a2")!;
    expect(sinGente).toBeDefined();
    expect(sinGente.conversations).toBe(0);
    expect(sinGente.spend).toBe(300);
    expect(sinGente.costPerConversation).toBeNull();
    expect(sinGente.headline).toBe("Nombre a2");
  });

  it("sin gasto registrado el costo es null, no 0", () => {
    const [a] = armarJerarquia(input({ rows: [fila("a1", { conversations: 4 })] })).ads;
    expect(a!.spend).toBeNull();
    expect(a!.costPerConversation).toBeNull();
    expect(a!.costPerLead).toBeNull();
  });

  it("calcula costo por conversación, prospecto y cita", () => {
    const [a] = armarJerarquia(
      input({
        rows: [fila("a1", { conversations: 10, leads: 5 })],
        spend: new Map([["a1", gasto(500)]]),
        bookings: new Map([["a1", 2]]),
      })
    ).ads;
    expect(a).toMatchObject({ spend: 500, costPerConversation: 50, costPerLead: 100, costPerBooking: 250, bookings: 2 });
  });

  it("con la agenda apagada no hay citas ni costo por cita", () => {
    const [a] = armarJerarquia(input({ rows: [fila("a1", { conversations: 2, leads: 1 })], spend: new Map([["a1", gasto(100)]]), bookings: null })).ads;
    expect(a!.bookings).toBeNull();
    expect(a!.costPerBooking).toBeNull();
    expect(a!.costPerLead).toBe(100);
  });

  it("una cita en cero es un costo de cita nulo (sin citas no hay costo)", () => {
    const [a] = armarJerarquia(input({ rows: [fila("a1", { conversations: 2 })], spend: new Map([["a1", gasto(100)]]), bookings: new Map() })).ads;
    expect(a!.bookings).toBe(0);
    expect(a!.costPerBooking).toBeNull();
  });

  it("monedas mezcladas: no se suma el gasto ni se calculan costos, y se avisa", () => {
    const out = armarJerarquia(
      input({
        rows: [fila("a1", { conversations: 2 }), fila("a2", { conversations: 2 })],
        spend: new Map([["a1", gasto(100, "MXN")], ["a2", gasto(100, "USD")]]),
      })
    );
    expect(out.mixedCurrency).toBe(true);
    for (const a of out.ads) {
      expect(a.spend).toBeNull();
      expect(a.costPerConversation).toBeNull();
    }
  });

  it("agrupa por campaña: suma conteos y gasto, y manda lo no resuelto a «Sin identificar»", () => {
    const out = armarJerarquia(
      input({
        query: { group: "campaign", campaignId: null, adsetId: null },
        rows: [
          fila("a1", { conversations: 5, leads: 2, won: 1 }),
          fila("a2", { conversations: 3, leads: 1, won: 0 }),
          fila("a3", { conversations: 7, leads: 4, won: 2 }),
          fila("a4", { conversations: 1 }),
        ],
        catalog: new Map([
          ["a1", cat("a1", "1", "1")],
          ["a2", cat("a2", "1", "2")],
          ["a3", cat("a3", "2", "3")],
        ]),
        spend: new Map([["a1", gasto(100)], ["a2", gasto(50)], ["a3", gasto(70)]]),
      })
    );
    const por = Object.fromEntries(out.groups.map((g) => [g.key, g]));
    expect(por["c-1"]).toMatchObject({ name: "Campaña 1", ads: 2, conversations: 8, leads: 3, won: 1, spend: 150, costPerConversation: 18.75, costPerLead: 50 });
    expect(por["c-2"]).toMatchObject({ ads: 1, conversations: 7, spend: 70 });
    expect(por[SIN_IDENTIFICAR]).toMatchObject({ name: "Sin identificar", ads: 1, conversations: 1, spend: null, costPerConversation: null });
  });

  it("al agrupar, el denominador solo cuenta anuncios CON gasto conocido", () => {
    const out = armarJerarquia(
      input({
        query: { group: "campaign", campaignId: null, adsetId: null },
        rows: [fila("a1", { conversations: 10 }), fila("a2", { conversations: 90 })],
        catalog: new Map([["a1", cat("a1", "1", "1")], ["a2", cat("a2", "1", "1")]]),
        // a2 trajo 90 conversaciones pero no tiene gasto registrado: no debe abaratar el costo de a1.
        spend: new Map([["a1", gasto(100)]]),
      })
    );
    expect(out.groups[0]).toMatchObject({ conversations: 100, spend: 100, costPerConversation: 10 });
  });

  it("agrupa por conjunto y dice a qué campaña pertenece", () => {
    const out = armarJerarquia(
      input({
        query: { group: "adset", campaignId: null, adsetId: null },
        rows: [fila("a1", { conversations: 2 }), fila("a2", { conversations: 5 })],
        catalog: new Map([["a1", cat("a1", "1", "1")], ["a2", cat("a2", "1", "2")]]),
      })
    );
    expect(out.groups.map((g) => [g.name, g.campaignName])).toEqual([
      ["Conjunto 2", "Campaña 1"],
      ["Conjunto 1", "Campaña 1"],
    ]);
  });

  it("filtra por campaña, por conjunto y por «sin identificar»", () => {
    const base = {
      rows: [fila("a1", { conversations: 5 }), fila("a2", { conversations: 3 }), fila("a3", { conversations: 1 })],
      catalog: new Map([["a1", cat("a1", "1", "1")], ["a2", cat("a2", "2", "3")]]),
    };
    const keys = (q: HierarchyInput["query"]) => armarJerarquia(input({ ...base, query: q })).ads.map((a) => a.key);
    expect(keys({ group: "ad", campaignId: "c-1", adsetId: null })).toEqual(["a1"]);
    expect(keys({ group: "ad", campaignId: null, adsetId: "as-3" })).toEqual(["a2"]);
    expect(keys({ group: "ad", campaignId: SIN_IDENTIFICAR, adsetId: null })).toEqual(["a3"]);
    expect(keys({ group: "ad", campaignId: "c-1", adsetId: "as-3" })).toEqual([]);
  });

  it("las opciones de filtro salen de lo que hay, sin filtrar", () => {
    const out = armarJerarquia(
      input({
        rows: [fila("a1", { conversations: 1 }), fila("a2", { conversations: 1 })],
        catalog: new Map([["a1", cat("a1", "1", "1")], ["a2", cat("a2", "2", "3")]]),
        query: { group: "ad", campaignId: "c-1", adsetId: null },
      })
    );
    expect(out.campaigns.map((c) => c.id)).toEqual(["c-1", "c-2"]);
    expect(out.adsets).toEqual([
      { id: "as-1", name: "Conjunto 1", campaignId: "c-1" },
      { id: "as-3", name: "Conjunto 3", campaignId: "c-2" },
    ]);
  });

  it("respeta el tope de filas por anuncio", () => {
    const rows = Array.from({ length: 60 }, (_, i) => fila(`a${i}`, { conversations: 100 - i }));
    const out = armarJerarquia(input({ rows, maxAds: 50 }));
    expect(out.ads).toHaveLength(50);
    expect(out.ads[0]!.key).toBe("a0");
  });

  it("sin catálogo ni gasto devuelve las filas de 019 con jerarquía nula", () => {
    const rows: FilaConInstante[] = [fila("a1", { conversations: 2 })];
    const [a] = armarJerarquia(input({ rows })).ads as AdRowDto[];
    expect(a).toMatchObject({ key: "a1", conversations: 2, adName: null, campaignId: null, spend: null });
  });
});
