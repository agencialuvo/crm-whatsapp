import type { AdGroupBy } from "@/lib/analytics";

/**
 * 039/040 — Navegación y selección de Resultados → Origen y anuncios, como funciones PURAS sobre la vista.
 *
 * La vista guarda UNA selección por nivel (las casillas de la tabla):
 *  - `campaignIds`: campañas marcadas  → filtran las pestañas Conjunto y Anuncio
 *  - `adsetIds`:    conjuntos marcados → filtran la pestaña Anuncio
 *  - `adIds`:       anuncios marcados  → solo cambian el Total
 * La pestaña actual no se filtra a sí misma (spec 040, S2): sus casillas sirven para llevarlas a otra pestaña y para el
 * Total. Cambiar de pestaña conserva las casillas (S1); cambiar las de arriba vacía las de abajo (S3).
 *
 * El clic en el nombre de una fila (039) es lo mismo que marcar esa fila sola y bajar de pestaña.
 */

export type AdsView = {
  group: AdGroupBy;
  campaignIds: string[];
  adsetIds: string[];
  adIds: string[];
};

export const VISTA_INICIAL: AdsView = { group: "ad", campaignIds: [], adsetIds: [], adIds: [] };
/** La que abre Resultados con la Marketing API conectada: por campaña, sin casillas. */
export const VISTA_POR_CAMPANA: AdsView = { group: "campaign", campaignIds: [], adsetIds: [], adIds: [] };

/** Lo que representa lo no resuelto por el catálogo (el mismo valor que usa el servidor). */
export const SIN_IDENTIFICAR = "sin-identificar";

/** La fila sobre la que se hace clic: lo mínimo que hace falta saber de ella. */
export type FilaNavegable = {
  /** Llave de la fila: id de Meta de la campaña o el conjunto, o `sin-identificar`. */
  key: string;
  level: "campaign" | "adset";
  /** Campaña a la que pertenece un conjunto (para bajar a sus anuncios sin perder el contexto). */
  campaignId?: string | null;
};

type Nivel = AdGroupBy;

/** Las casillas marcadas de un nivel. */
export function seleccionDe(view: AdsView, nivel: Nivel): string[] {
  return nivel === "campaign" ? view.campaignIds : nivel === "adset" ? view.adsetIds : view.adIds;
}

/** Sin repetidos y en el orden en que se marcaron. */
function unicos(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Fija las casillas de un nivel. Cambiar las de arriba vacía las de abajo (S3): podrían ser de algo que ya no está
 * marcado. Si la selección no cambia, no se toca nada de lo de abajo.
 */
export function withSelection(view: AdsView, nivel: Nivel, ids: readonly string[]): AdsView {
  const nuevo = unicos(ids);
  const actual = seleccionDe(view, nivel);
  if (nuevo.length === actual.length && nuevo.every((x, i) => x === actual[i])) return view;
  if (nivel === "campaign") return { ...view, campaignIds: nuevo, adsetIds: [], adIds: [] };
  if (nivel === "adset") return { ...view, adsetIds: nuevo, adIds: [] };
  return { ...view, adIds: nuevo };
}

/** Marca o desmarca UNA fila. */
export function toggle(view: AdsView, nivel: Nivel, key: string): AdsView {
  const actual = seleccionDe(view, nivel);
  return withSelection(view, nivel, actual.includes(key) ? actual.filter((k) => k !== key) : [...actual, key]);
}

/** La casilla maestra: marca (o desmarca) todas las filas visibles sin tocar lo marcado que no se ve. */
export function toggleAll(view: AdsView, nivel: Nivel, visibleKeys: readonly string[], on: boolean): AdsView {
  const actual = seleccionDe(view, nivel);
  const visibles = new Set(visibleKeys);
  return withSelection(view, nivel, on ? [...actual, ...visibleKeys] : actual.filter((k) => !visibles.has(k)));
}

export function clearLevel(view: AdsView, nivel: Nivel): AdsView {
  return withSelection(view, nivel, []);
}

/** Estado de la casilla maestra según lo marcado entre lo visible. */
export function masterState(selected: readonly string[], visibleKeys: readonly string[]): "none" | "some" | "all" {
  if (visibleKeys.length === 0) return "none";
  const marcadas = new Set(selected);
  const n = visibleKeys.filter((k) => marcadas.has(k)).length;
  return n === 0 ? "none" : n === visibleKeys.length ? "all" : "some";
}

/**
 * Lo que la pestaña manda a la API: los filtros que vienen de arriba y las llaves marcadas en ella (solo para el Total).
 *  - Campaña: sin filtros
 *  - Conjunto: filtra por las campañas marcadas
 *  - Anuncio: filtra por los conjuntos marcados o, sin ellos, por las campañas marcadas
 */
export function filtersFor(view: AdsView): { campaignIds: string[]; adsetIds: string[]; selected: string[] } {
  if (view.group === "campaign") return { campaignIds: [], adsetIds: [], selected: view.campaignIds };
  if (view.group === "adset") return { campaignIds: view.campaignIds, adsetIds: [], selected: view.adsetIds };
  return {
    campaignIds: view.adsetIds.length > 0 ? [] : view.campaignIds,
    adsetIds: view.adsetIds,
    selected: view.adIds,
  };
}

/**
 * Clic en el nombre de una fila: la deja como única marcada y baja un nivel.
 *  - campaña → Conjuntos de esa campaña
 *  - conjunto → Anuncios de ese conjunto (conservando las campañas marcadas o, sin ellas, la de ese conjunto)
 */
export function drillInto(view: AdsView, fila: FilaNavegable): AdsView {
  if (fila.level === "campaign") return { group: "adset", campaignIds: [fila.key], adsetIds: [], adIds: [] };
  const campanas = view.campaignIds.length > 0 ? view.campaignIds : fila.campaignId ? [fila.campaignId] : [];
  return { group: "ad", campaignIds: campanas, adsetIds: [fila.key], adIds: [] };
}

/** Cambiar de pestaña a mano: las casillas se conservan (S1). */
export function goToLevel(view: AdsView, group: AdGroupBy): AdsView {
  return view.group === group ? view : { ...view, group };
}

/** Elegir una campaña en el selector equivale a hacer clic en ella: la deja sola y baja a sus conjuntos. */
export function pickCampaign(view: AdsView, campaignId: string): AdsView {
  if (!campaignId) return withSelection(view, "campaign", []);
  const marcada = withSelection(view, "campaign", [campaignId]);
  return { ...marcada, group: view.group === "campaign" ? "adset" : view.group };
}

/** Elegir un conjunto en el selector equivale a hacer clic en él: lo deja solo y baja a sus anuncios. */
export function pickAdset(view: AdsView, adsetId: string): AdsView {
  if (!adsetId) return withSelection(view, "adset", []);
  return { ...withSelection(view, "adset", [adsetId]), group: "ad" };
}

export type Miga = {
  /** Texto a pintar. */
  label: string;
  /** A dónde lleva el clic; `null` en la última (donde ya se está). */
  view: AdsView | null;
};

type Nombres = { campaigns: { id: string; name: string }[]; adsets: { id: string; name: string }[] };

function etiqueta(lista: { id: string; name: string }[], ids: readonly string[], uno: string, varios: string): string {
  if (ids.length > 1) return `${ids.length} ${varios}`;
  const id = ids[0]!;
  if (id === SIN_IDENTIFICAR) return `Sin identificar`;
  return lista.find((x) => x.id === id)?.name ?? id ?? uno;
}

/**
 * Las migas de pan: solo para lo que viene de ARRIBA de la pestaña actual (las casillas de la propia pestaña no son
 * ubicación). Sin filtros de arriba devuelve `[]` y la pantalla no pinta nada.
 */
export function crumbs(view: AdsView, nombres: Nombres): Miga[] {
  if (view.group === "campaign") return [];
  const campanas = view.campaignIds;
  const conjuntos = view.group === "ad" ? view.adsetIds : [];
  if (campanas.length === 0 && conjuntos.length === 0) return [];

  const todas: Miga = { label: "Todas las campañas", view: { ...VISTA_POR_CAMPANA } };
  const out: Miga[] = [todas];
  // En Anuncio, con conjuntos marcados, las campañas son contexto; sin ellos son el filtro.
  if (campanas.length > 0) {
    out.push({
      label: etiqueta(nombres.campaigns, campanas, "campaña", "campañas"),
      view: conjuntos.length > 0 ? { group: "adset", campaignIds: campanas, adsetIds: [], adIds: [] } : null,
    });
  }
  if (conjuntos.length > 0) out.push({ label: etiqueta(nombres.adsets, conjuntos, "conjunto", "conjuntos"), view: null });
  // La última miga es donde se está: sin enlace.
  const ultima = out[out.length - 1]!;
  out[out.length - 1] = { ...ultima, view: null };
  return out;
}

const PLURAL = {
  campaign: ["campaña", "campañas"],
  adset: ["conjunto", "conjuntos"],
  ad: ["anuncio", "anuncios"],
} as const;

function cuenta(n: number, nivel: Nivel, sufijo: "seleccionado" | ""): string {
  const [uno, varios] = PLURAL[nivel];
  const fem = nivel === "campaign";
  const suf = sufijo ? (n === 1 ? (fem ? " seleccionada" : " seleccionado") : fem ? " seleccionadas" : " seleccionados") : "";
  return `${n} ${n === 1 ? uno : varios}${suf}`;
}

export type Pildora = { texto: string; accion: AdsView };

/**
 * Las píldoras sobre la tabla (S7): la que dice de dónde viene el filtro («Conjuntos de 2 campañas», con «Quitar») y la
 * de lo marcado en ESTA pestaña («3 conjuntos seleccionados», con «Limpiar»). `visibleKeys` acota la cuenta a las filas
 * presentes: una casilla de algo que ya no se ve no se cuenta.
 */
export function summary(
  view: AdsView,
  visibleKeys?: readonly string[]
): { filtro: Pildora | null; seleccion: Pildora | null } {
  let filtro: Pildora | null = null;
  if (view.group === "adset" && view.campaignIds.length > 0) {
    filtro = { texto: `Conjuntos de ${cuenta(view.campaignIds.length, "campaign", "")}`, accion: withSelection(view, "campaign", []) };
  } else if (view.group === "ad" && view.adsetIds.length > 0) {
    filtro = { texto: `Anuncios de ${cuenta(view.adsetIds.length, "adset", "")}`, accion: withSelection(view, "adset", []) };
  } else if (view.group === "ad" && view.campaignIds.length > 0) {
    filtro = { texto: `Anuncios de ${cuenta(view.campaignIds.length, "campaign", "")}`, accion: withSelection(view, "campaign", []) };
  }

  const propias = seleccionDe(view, view.group);
  const presentes = visibleKeys ? propias.filter((k) => visibleKeys.includes(k)) : propias;
  const seleccion: Pildora | null =
    presentes.length > 0 ? { texto: cuenta(presentes.length, view.group, "seleccionado"), accion: clearLevel(view, view.group) } : null;
  return { filtro, seleccion };
}

/** ¿Hay alguna casilla marcada en cualquier nivel? */
export function tieneFiltros(view: AdsView): boolean {
  return view.campaignIds.length > 0 || view.adsetIds.length > 0 || view.adIds.length > 0;
}
