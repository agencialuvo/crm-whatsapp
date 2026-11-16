import { describe, expect, it } from "vitest";
import {
  buildAdsListPath,
  parseAdsPage,
  safePreviewLink,
} from "@/lib/meta/ads";
import { rate } from "@/lib/analytics";
import {
  clearLevel,
  crumbs,
  drillInto,
  filtersFor,
  goToLevel,
  masterState,
  pickAdset,
  pickCampaign,
  seleccionDe,
  SIN_IDENTIFICAR,
  summary,
  tieneFiltros,
  toggle,
  toggleAll,
  VISTA_INICIAL,
  VISTA_POR_CAMPANA,
  withSelection,
  type AdsView,
} from "@/lib/ads-nav";
import { armarJerarquia, llaveDeFila, type CatalogEntry, type FilaConInstante } from "@/server/analytics/ads-hierarchy";

/** 040 — Selección múltiple con casillas y creativos de los anuncios. Todo puro: sin red ni base. */

const q = (path: string) => new URL(`http://x/${path}`).searchParams;
const vista = (over: Partial<AdsView> = {}): AdsView => ({ ...VISTA_POR_CAMPANA, ...over });

describe("selección: marcar y desmarcar", () => {
  it("toggle marca y desmarca una fila, sin repetidos y en orden", () => {
    let v = toggle(VISTA_POR_CAMPANA, "campaign", "c1");
    v = toggle(v, "campaign", "c2");
    expect(v.campaignIds).toEqual(["c1", "c2"]);
    v = toggle(v, "campaign", "c1");
    expect(v.campaignIds).toEqual(["c2"]);
  });

  it("S3: cambiar las campañas marcadas vacía conjuntos y anuncios marcados", () => {
    const v = vista({ campaignIds: ["c1"], adsetIds: ["s1"], adIds: ["a1"] });
    expect(toggle(v, "campaign", "c2")).toMatchObject({ campaignIds: ["c1", "c2"], adsetIds: [], adIds: [] });
  });

  it("S3: cambiar los conjuntos vacía los anuncios, pero no las campañas", () => {
    const v = vista({ campaignIds: ["c1"], adsetIds: ["s1"], adIds: ["a1"] });
    expect(toggle(v, "adset", "s2")).toMatchObject({ campaignIds: ["c1"], adsetIds: ["s1", "s2"], adIds: [] });
  });

  it("marcar anuncios no toca nada de arriba", () => {
    const v = vista({ campaignIds: ["c1"], adsetIds: ["s1"] });
    expect(toggle(v, "ad", "a1")).toMatchObject({ campaignIds: ["c1"], adsetIds: ["s1"], adIds: ["a1"] });
  });

  it("una selección que no cambia devuelve la MISMA vista (no se vacía lo de abajo en vano)", () => {
    const v = vista({ campaignIds: ["c1"], adsetIds: ["s1"] });
    expect(withSelection(v, "campaign", ["c1"])).toBe(v);
  });

  it("la casilla maestra marca todo lo visible sin perder lo marcado que no se ve, y desmarca solo lo visible", () => {
    const v = vista({ group: "campaign", campaignIds: ["fuera"] });
    const todas = toggleAll(v, "campaign", ["c1", "c2"], true);
    expect(todas.campaignIds).toEqual(["fuera", "c1", "c2"]);
    expect(toggleAll(todas, "campaign", ["c1", "c2"], false).campaignIds).toEqual(["fuera"]);
  });

  it("clearLevel limpia la selección de ese nivel (y, por S3, lo de abajo)", () => {
    const v = vista({ campaignIds: ["c1"], adsetIds: ["s1"], adIds: ["a1"] });
    expect(clearLevel(v, "campaign")).toMatchObject({ campaignIds: [], adsetIds: [], adIds: [] });
    expect(clearLevel(v, "ad")).toMatchObject({ campaignIds: ["c1"], adsetIds: ["s1"], adIds: [] });
  });

  it("seleccionDe lee el nivel que toca", () => {
    const v = vista({ campaignIds: ["c"], adsetIds: ["s"], adIds: ["a"] });
    expect([seleccionDe(v, "campaign"), seleccionDe(v, "adset"), seleccionDe(v, "ad")]).toEqual([["c"], ["s"], ["a"]]);
  });
});

describe("casilla maestra", () => {
  it("none / some / all según lo marcado entre lo visible", () => {
    expect(masterState([], ["a", "b"])).toBe("none");
    expect(masterState(["a"], ["a", "b"])).toBe("some");
    expect(masterState(["a", "b"], ["a", "b"])).toBe("all");
    // Lo marcado que no se ve no cuenta.
    expect(masterState(["x"], ["a", "b"])).toBe("none");
    expect(masterState(["a", "b", "x"], ["a", "b"])).toBe("all");
  });
  it("sin filas visibles no hay nada que marcar", () => {
    expect(masterState(["a"], [])).toBe("none");
  });
});

describe("filtrado cruzado al cambiar de pestaña", () => {
  const v = vista({ campaignIds: ["c1", "c2"], adsetIds: ["s1"], adIds: ["a1"] });

  it("Campaña: sin filtros; lo marcado en ella solo va al Total", () => {
    expect(filtersFor({ ...v, group: "campaign" })).toEqual({ campaignIds: [], adsetIds: [], selected: ["c1", "c2"] });
  });
  it("Conjunto: filtra por las campañas marcadas; lo marcado en él va al Total", () => {
    expect(filtersFor({ ...v, group: "adset" })).toEqual({ campaignIds: ["c1", "c2"], adsetIds: [], selected: ["s1"] });
  });
  it("Anuncio con conjuntos marcados: filtra por ellos (las campañas ya los contienen)", () => {
    expect(filtersFor({ ...v, group: "ad" })).toEqual({ campaignIds: [], adsetIds: ["s1"], selected: ["a1"] });
  });
  it("Anuncio sin conjuntos marcados: filtra por las campañas marcadas", () => {
    expect(filtersFor({ ...v, group: "ad", adsetIds: [], adIds: [] })).toEqual({ campaignIds: ["c1", "c2"], adsetIds: [], selected: [] });
  });
  it("sin nada marcado no se filtra nada en ninguna pestaña", () => {
    for (const group of ["campaign", "adset", "ad"] as const) {
      expect(filtersFor({ ...VISTA_INICIAL, group })).toEqual({ campaignIds: [], adsetIds: [], selected: [] });
    }
  });
  it("cambiar de pestaña CONSERVA las casillas (S1)", () => {
    const hondo = goToLevel(v, "ad");
    expect(hondo).toMatchObject({ group: "ad", campaignIds: ["c1", "c2"], adsetIds: ["s1"], adIds: ["a1"] });
    expect(goToLevel(hondo, "campaign").campaignIds).toEqual(["c1", "c2"]);
    expect(goToLevel(v, v.group)).toBe(v);
  });
});

describe("el clic en el nombre es marcar esa fila sola y bajar", () => {
  it("campaña → Conjuntos de esa campaña, descartando casillas de abajo", () => {
    expect(drillInto(vista({ campaignIds: ["x", "y"], adsetIds: ["s"] }), { key: "c1", level: "campaign" })).toEqual({
      group: "adset", campaignIds: ["c1"], adsetIds: [], adIds: [],
    });
  });
  it("conjunto → Anuncios de ese conjunto; conserva las campañas marcadas, o toma la del conjunto", () => {
    expect(drillInto(vista({ group: "adset", campaignIds: ["c1", "c2"] }), { key: "s9", level: "adset", campaignId: "c1" })).toEqual({
      group: "ad", campaignIds: ["c1", "c2"], adsetIds: ["s9"], adIds: [],
    });
    expect(drillInto(vista({ group: "adset" }), { key: "s9", level: "adset", campaignId: "cX" }).campaignIds).toEqual(["cX"]);
    expect(drillInto(vista({ group: "adset" }), { key: SIN_IDENTIFICAR, level: "adset", campaignId: null }).campaignIds).toEqual([]);
  });
  it("«sin identificar» se puede abrir", () => {
    expect(drillInto(VISTA_POR_CAMPANA, { key: SIN_IDENTIFICAR, level: "campaign" }).campaignIds).toEqual([SIN_IDENTIFICAR]);
  });
});

describe("los selectores de búsqueda equivalen a marcar una sola fila", () => {
  it("elegir una campaña la deja sola y baja a sus conjuntos desde la pestaña Campaña", () => {
    expect(pickCampaign(vista({ campaignIds: ["a", "b"] }), "c1")).toMatchObject({ group: "adset", campaignIds: ["c1"] });
    expect(pickCampaign({ ...VISTA_INICIAL, group: "ad" }, "c1")).toMatchObject({ group: "ad", campaignIds: ["c1"] });
  });
  it("elegir «todas» las vacía (y vacía lo de abajo)", () => {
    expect(pickCampaign(vista({ group: "adset", campaignIds: ["c1"], adsetIds: ["s1"] }), "")).toMatchObject({ campaignIds: [], adsetIds: [] });
  });
  it("elegir un conjunto lo deja solo y baja a sus anuncios", () => {
    expect(pickAdset(vista({ group: "adset", campaignIds: ["c1"] }), "s1")).toMatchObject({ group: "ad", campaignIds: ["c1"], adsetIds: ["s1"] });
    expect(pickAdset(vista({ group: "ad", adsetIds: ["s1"] }), "")).toMatchObject({ adsetIds: [] });
  });
});

describe("migas y píldoras", () => {
  const nombres = {
    campaigns: [{ id: "c1", name: "Campaña Alfa" }],
    adsets: [{ id: "s1", name: "Conjunto Uno" }],
  };

  it("la pestaña Campaña no tiene migas (sus casillas no son ubicación)", () => {
    expect(crumbs(vista({ campaignIds: ["c1"] }), nombres)).toEqual([]);
  });
  it("con una campaña marcada, en Conjunto: «Todas las campañas › Campaña Alfa»", () => {
    const m = crumbs(vista({ group: "adset", campaignIds: ["c1"] }), nombres);
    expect(m.map((x) => x.label)).toEqual(["Todas las campañas", "Campaña Alfa"]);
    expect(m[0]!.view).toEqual({ group: "campaign", campaignIds: [], adsetIds: [], adIds: [] });
    expect(m[1]!.view).toBeNull();
  });
  it("con varias, la miga cuenta («2 campañas»)", () => {
    const m = crumbs(vista({ group: "adset", campaignIds: ["c1", "c2"] }), nombres);
    expect(m[1]!.label).toBe("2 campañas");
  });
  it("en Anuncio con campaña y conjunto: tres migas; la de la campaña vuelve a sus conjuntos", () => {
    const m = crumbs(vista({ group: "ad", campaignIds: ["c1"], adsetIds: ["s1"] }), nombres);
    expect(m.map((x) => x.label)).toEqual(["Todas las campañas", "Campaña Alfa", "Conjunto Uno"]);
    expect(m[1]!.view).toEqual({ group: "adset", campaignIds: ["c1"], adsetIds: [], adIds: [] });
  });
  it("«sin identificar» se nombra", () => {
    expect(crumbs(vista({ group: "adset", campaignIds: [SIN_IDENTIFICAR] }), nombres)[1]!.label).toBe("Sin identificar");
  });

  it("píldora de selección: singular, plural y género; «Limpiar» vacía ese nivel", () => {
    expect(summary(vista({ campaignIds: ["a"] })).seleccion!.texto).toBe("1 campaña seleccionada");
    expect(summary(vista({ campaignIds: ["a", "b"] })).seleccion!.texto).toBe("2 campañas seleccionadas");
    expect(summary(vista({ group: "adset", adsetIds: ["s"] })).seleccion!.texto).toBe("1 conjunto seleccionado");
    expect(summary(vista({ group: "ad", adIds: ["x", "y", "z"] })).seleccion!.texto).toBe("3 anuncios seleccionados");
    const v = vista({ campaignIds: ["a", "b"], adsetIds: ["s"] });
    expect(summary(v).seleccion!.accion).toMatchObject({ campaignIds: [], adsetIds: [] });
  });
  it("la cuenta de la píldora solo cuenta las filas presentes", () => {
    expect(summary(vista({ campaignIds: ["a", "ya-no-esta"] }), ["a", "b"]).seleccion!.texto).toBe("1 campaña seleccionada");
    expect(summary(vista({ campaignIds: ["ya-no-esta"] }), ["a", "b"]).seleccion).toBeNull();
  });
  it("píldora de filtro: dice de dónde viene lo que se ve y «Quitar» limpia ese nivel", () => {
    const enConjuntos = summary(vista({ group: "adset", campaignIds: ["c1", "c2"] }));
    expect(enConjuntos.filtro!.texto).toBe("Conjuntos de 2 campañas");
    expect(enConjuntos.filtro!.accion.campaignIds).toEqual([]);
    expect(summary(vista({ group: "ad", adsetIds: ["s1"], campaignIds: ["c1"] })).filtro!.texto).toBe("Anuncios de 1 conjunto");
    expect(summary(vista({ group: "ad", campaignIds: ["c1", "c2"] })).filtro!.texto).toBe("Anuncios de 2 campañas");
    expect(summary(VISTA_POR_CAMPANA).filtro).toBeNull();
  });
  it("tieneFiltros mira cualquier nivel", () => {
    expect(tieneFiltros(VISTA_INICIAL)).toBe(false);
    expect(tieneFiltros(vista({ adIds: ["a"] }))).toBe(true);
  });
});

/* ── El servidor: unión de ids y Total de la selección ────────── */

const fila = (key: string, over: Partial<FilaConInstante> = {}): FilaConInstante => ({
  key, sourceId: key, sourceType: "ad", headline: null, imageAssetId: null,
  conversations: 0, leads: 0, won: 0, winRate: rate(0, 0), lastAt: 0, ...over,
});
const cat = (adId: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  adId, adName: `Anuncio ${adId}`, adsetId: "s1", adsetName: "Conjunto 1", campaignId: "c1", campaignName: "Campaña 1", effectiveStatus: "ACTIVE", ...over,
});

/** Tres campañas: c1 (a1, a2), c2 (a3) y c3 (a4). Cada anuncio con su gasto y conversaciones. */
function mundo() {
  const rows = [
    fila("a1", { conversations: 10, leads: 5, won: 1 }),
    fila("a2", { conversations: 20, leads: 10, won: 2 }),
    fila("a3", { conversations: 5, leads: 5, won: 0 }),
    fila("a4", { conversations: 0 }),
  ];
  const catalog = new Map([
    ["a1", cat("a1")],
    ["a2", cat("a2", { adsetId: "s2", adsetName: "Conjunto 2" })],
    ["a3", cat("a3", { campaignId: "c2", campaignName: "Campaña 2", adsetId: "s3", adsetName: "Conjunto 3" })],
    ["a4", cat("a4", { campaignId: "c3", campaignName: "Campaña 3", adsetId: "s4", adsetName: "Conjunto 4" })],
  ]);
  const spend = new Map([
    ["a1", { amount: 100, currencies: ["MXN"] }],
    ["a2", { amount: 200, currencies: ["MXN"] }],
    ["a3", { amount: 50, currencies: ["MXN"] }],
    ["a4", { amount: 40, currencies: ["MXN"] }],
  ]);
  return { rows, catalog, spend, bookings: null, maxAds: 50 };
}
const base = { campaignId: null, adsetId: null } as const;

describe("armarJerarquia con varias campañas y conjuntos", () => {
  it("el filtro por varias campañas es una UNIÓN", () => {
    const out = armarJerarquia({ ...mundo(), query: { group: "ad", ...base, campaignIds: ["c1", "c2"] } });
    expect(out.ads.map((a) => a.key).sort()).toEqual(["a1", "a2", "a3"]);
    expect(out.total).toMatchObject({ ads: 3, conversations: 35, spend: 350 });
  });
  it("el filtro por varios conjuntos también", () => {
    const out = armarJerarquia({ ...mundo(), query: { group: "ad", ...base, adsetIds: ["s2", "s4"] } });
    expect(out.ads.map((a) => a.key).sort()).toEqual(["a2", "a4"]);
  });
  it("campaignIds manda sobre el campaignId único de 039, que sigue valiendo solo", () => {
    expect(armarJerarquia({ ...mundo(), query: { group: "ad", campaignId: "c3", adsetId: null } }).ads.map((a) => a.key)).toEqual(["a4"]);
    expect(armarJerarquia({ ...mundo(), query: { group: "ad", campaignId: "c3", adsetId: null, campaignIds: ["c2"] } }).ads.map((a) => a.key)).toEqual(["a3"]);
  });
  it("las campañas y conjuntos se combinan (Y)", () => {
    const out = armarJerarquia({ ...mundo(), query: { group: "ad", ...base, campaignIds: ["c1"], adsetIds: ["s2"] } });
    expect(out.ads.map((a) => a.key)).toEqual(["a2"]);
  });
  it("«sin-identificar» dentro de una lista filtra lo no resuelto", () => {
    const m = mundo();
    m.rows.push(fila("huerfano", { conversations: 1 }));
    const out = armarJerarquia({ ...m, query: { group: "ad", ...base, campaignIds: [SIN_IDENTIFICAR, "c3"] } });
    expect(out.ads.map((a) => a.key).sort()).toEqual(["a4", "huerfano"]);
  });
});

describe("el Total sigue a la selección (S4/S5)", () => {
  it("sin marcar es el de toda la vista; marcando dos campañas es el de ellas, con sus costos", () => {
    const todo = armarJerarquia({ ...mundo(), query: { group: "campaign", ...base } });
    expect(todo.selectedCount).toBe(0);
    expect(todo.total).toMatchObject({ ads: 4, conversations: 35, spend: 390 });

    const dos = armarJerarquia({ ...mundo(), query: { group: "campaign", ...base, selected: ["c1", "c2"] } });
    // Dos campañas marcadas (que juntas reúnen tres anuncios): se cuentan las FILAS de la pestaña, no los anuncios.
    expect(dos.selectedCount).toBe(2);
    expect(dos.total).toMatchObject({ ads: 3, conversations: 35, leads: 20, won: 3, spend: 350, costPerConversation: 10 });
  });
  it("en la pestaña Conjunto la llave es el conjunto; en Anuncio, el anuncio", () => {
    const sets = armarJerarquia({ ...mundo(), query: { group: "adset", ...base, selected: ["s1"] } });
    expect(sets.total).toMatchObject({ ads: 1, conversations: 10, spend: 100 });
    const ads = armarJerarquia({ ...mundo(), query: { group: "ad", ...base, selected: ["a2", "a3"] } });
    expect(ads.total).toMatchObject({ ads: 2, conversations: 25, spend: 250, costPerConversation: 10 });
  });
  it("el filtro de arriba y la selección conviven: el Total es de lo marcado DENTRO de lo filtrado", () => {
    const out = armarJerarquia({ ...mundo(), query: { group: "ad", ...base, campaignIds: ["c1"], selected: ["a1", "a3"] } });
    // a3 no está en c1: solo cuenta a1.
    expect(out.total).toMatchObject({ ads: 1, conversations: 10 });
    expect(out.ads.map((a) => a.key).sort()).toEqual(["a1", "a2"]);
  });
  it("S5: una selección que ya no existe NO vacía el Total: es el de toda la vista", () => {
    const out = armarJerarquia({ ...mundo(), query: { group: "campaign", ...base, selected: ["fantasma"] } });
    expect(out.selectedCount).toBe(0);
    expect(out.total).toMatchObject({ ads: 4, spend: 390 });
  });
  it("un costo sigue siendo null cuando falta el gasto o no hay resultados", () => {
    const out = armarJerarquia({ ...mundo(), query: { group: "ad", ...base, selected: ["a4"] } });
    expect(out.total).toMatchObject({ ads: 1, conversations: 0, spend: 40, costPerConversation: null });
  });
  it("llaveDeFila por pestaña", () => {
    expect(llaveDeFila("campaign", { key: "a1", campaignId: "c1" })).toBe("c1");
    expect(llaveDeFila("campaign", { key: "a1", campaignId: null })).toBe(SIN_IDENTIFICAR);
    expect(llaveDeFila("adset", { key: "a1", adsetId: "s1" })).toBe("s1");
    expect(llaveDeFila("ad", { key: "a1" })).toBe("a1");
  });
});

describe("el creativo viaja en la fila", () => {
  it("lleva imagen copiada, titular, texto y enlace validado; sin nada es null", () => {
    const m = mundo();
    m.catalog.set("a1", cat("a1", { creativeAssetId: "med_1", creativeTitle: "Corte 2x1", creativeBody: "Solo hoy", previewLink: "https://fb.me/xyz" }));
    m.catalog.set("a2", cat("a2", { previewLink: "javascript:alert(1)" }));
    const out = armarJerarquia({ ...m, query: { group: "ad", ...base } });
    expect(out.ads.find((a) => a.key === "a1")!.creative).toEqual({ assetId: "med_1", title: "Corte 2x1", body: "Solo hoy", previewLink: "https://fb.me/xyz" });
    // Un enlace que no pasa la validación se descarta, y sin nada más la fila no trae creativo.
    expect(out.ads.find((a) => a.key === "a2")!.creative).toBeNull();
  });
});

/* ── Consulta y lectura de creativos ──────────────────────────── */

describe("listado con creativos", () => {
  it("pide el creativo y el enlace, con páginas de 100", () => {
    const p = q(buildAdsListPath("act_1", null, { creative: true }));
    expect(p.get("fields")).toBe(
      "id,name,effective_status,adset{id,name},campaign{id,name},preview_shareable_link,creative{id,thumbnail_url,image_url,title,body}"
    );
    expect(p.get("limit")).toBe("100");
  });
  it("sin creativos es la consulta de 039, de 200", () => {
    const p = q(buildAdsListPath("act_1"));
    expect(p.get("fields")).toBe("id,name,effective_status,adset{id,name},campaign{id,name}");
    expect(p.get("limit")).toBe("200");
  });

  it("parseAdsPage lee el creativo y valida el enlace", () => {
    const { ads } = parseAdsPage({
      data: [
        {
          id: "1", name: "A", preview_shareable_link: "https://fb.me/e/abc",
          creative: { id: "c1", title: " Titular ", body: "Texto", image_url: "https://scontent.fbcdn.net/a.jpg", thumbnail_url: "https://scontent.fbcdn.net/t.jpg" },
        },
        { id: "2", name: "B", preview_shareable_link: "http://evil.test/x", creative: {} },
        { id: "3", name: "C" },
      ],
    });
    expect(ads[0]!.creative).toEqual({
      creativeId: "c1", title: "Titular", body: "Texto",
      imageUrl: "https://scontent.fbcdn.net/a.jpg", thumbnailUrl: "https://scontent.fbcdn.net/t.jpg",
    });
    expect(ads[0]!.previewLink).toBe("https://fb.me/e/abc");
    // Un enlace inseguro se descarta; un creativo vacío no es un creativo.
    expect(ads[1]!.previewLink).toBeNull();
    expect(ads[1]!.creative).toBeUndefined();
    // Sin pedirlos no aparecen llaves nuevas (la consulta de 039 sigue idéntica).
    expect("creative" in ads[2]! || "previewLink" in ads[2]!).toBe(false);
  });
});

describe("enlace de vista previa", () => {
  it("acepta https de hosts de Meta", () => {
    for (const ok of ["https://fb.me/abc", "https://www.facebook.com/ads/api/preview_iframe.php?d=1", "https://business.facebook.com/x", "https://fb.com/y"]) {
      expect(safePreviewLink(ok), ok).not.toBeNull();
    }
  });
  it("rechaza todo lo demás", () => {
    for (const mal of [
      "http://fb.me/abc", "javascript:alert(1)", "data:text/html,<script>", "https://evil.test/", "https://facebook.com.evil.test/",
      "https://user:pass@facebook.com/", "https://facebook.com:8443/", "https://notfacebook.com/", "ftp://facebook.com/", "no es url", "", null, undefined, 42,
      `https://facebook.com/${"a".repeat(2100)}`,
    ]) {
      expect(safePreviewLink(mal as never), String(mal)).toBeNull();
    }
  });
});
