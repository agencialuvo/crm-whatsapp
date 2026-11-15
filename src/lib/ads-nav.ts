import type { AdGroupBy } from "@/lib/analytics";

/**
 * 039 — Navegación Campaña › Conjunto › Anuncio de Resultados, como funciones PURAS sobre la vista.
 *
 * La vista es el mismo estado que la 038 mandaba a la API (`group`, `campaignId`, `adsetId`): el
 * drill-down no agrega nada al contrato, solo evita que el dueño tenga que cambiar de pestaña y de
 * filtro por separado. Los dos selectores y los clics usan estas mismas funciones, así no se contradicen.
 */

export type AdsView = { group: AdGroupBy; campaignId: string; adsetId: string };

export const VISTA_INICIAL: AdsView = { group: "ad", campaignId: "", adsetId: "" };

/** Lo que representa lo no resuelto por el catálogo (el mismo valor que usa el servidor). */
export const SIN_IDENTIFICAR = "sin-identificar";

/** La fila sobre la que se hace clic: lo mínimo que hace falta saber de ella. */
export type FilaNavegable = {
  /** Id de Meta de la campaña o el conjunto, o `sin-identificar`. */
  key: string;
  level: "campaign" | "adset";
  /** Campaña a la que pertenece un conjunto (para bajar a sus anuncios sin perder el filtro). */
  campaignId?: string | null;
};

/** La vista inicial al abrir Resultados con la Marketing API: por campaña, sin filtros. */
export const VISTA_POR_CAMPANA: AdsView = { group: "campaign", campaignId: "", adsetId: "" };

/**
 * Clic en el nombre de una fila: baja un nivel con esa fila como filtro.
 *  - campaña → Conjuntos de esa campaña
 *  - conjunto → Anuncios de ese conjunto (conservando su campaña)
 */
export function drillInto(view: AdsView, fila: FilaNavegable): AdsView {
  if (fila.level === "campaign") return { group: "adset", campaignId: fila.key, adsetId: "" };
  return {
    group: "ad",
    // Con «sin identificar» no hay campaña que conservar: el filtro de conjunto basta.
    campaignId: fila.campaignId ?? view.campaignId,
    adsetId: fila.key,
  };
}

/**
 * Cambiar de pestaña a mano. Subir de nivel limpia lo que queda por debajo (no tiene sentido «Campaña»
 * filtrada por un conjunto); bajar conserva lo elegido.
 *  - Campaña: sin filtros · Conjunto: conserva la campaña · Anuncio: conserva ambos
 */
export function goToLevel(view: AdsView, group: AdGroupBy): AdsView {
  if (group === "campaign") return { group, campaignId: "", adsetId: "" };
  if (group === "adset") return { group, campaignId: view.campaignId, adsetId: "" };
  return { group, campaignId: view.campaignId, adsetId: view.adsetId };
}

/** Elegir una campaña en el selector equivale a hacer clic en ella: baja a sus conjuntos. */
export function pickCampaign(view: AdsView, campaignId: string): AdsView {
  if (!campaignId) return { ...view, campaignId: "", adsetId: "" };
  return { group: view.group === "campaign" ? "adset" : view.group, campaignId, adsetId: "" };
}

/** Elegir un conjunto en el selector equivale a hacer clic en él: baja a sus anuncios. */
export function pickAdset(view: AdsView, adsetId: string): AdsView {
  if (!adsetId) return { ...view, adsetId: "" };
  return { group: "ad", campaignId: view.campaignId, adsetId };
}

export type Miga = {
  /** Texto a pintar. */
  label: string;
  /** A dónde lleva el clic; `null` en la última (donde ya se está). */
  view: AdsView | null;
};

type Nombres = { campaigns: { id: string; name: string }[]; adsets: { id: string; name: string }[] };

function nombreDe(lista: { id: string; name: string }[], id: string): string {
  if (id === SIN_IDENTIFICAR) return "Sin identificar";
  return lista.find((x) => x.id === id)?.name ?? id;
}

/**
 * Las migas de pan para la vista: «Todas las campañas › Campaña › Conjunto». Solo tiene sentido con algún
 * filtro puesto; sin filtros devuelve `[]` y la pantalla no pinta nada.
 */
export function crumbs(view: AdsView, nombres: Nombres): Miga[] {
  if (!view.campaignId && !view.adsetId) return [];
  const out: Miga[] = [{ label: "Todas las campañas", view: { group: "campaign", campaignId: "", adsetId: "" } }];
  if (view.campaignId) {
    out.push({
      label: nombreDe(nombres.campaigns, view.campaignId),
      // Llevar a la campaña = ver sus conjuntos.
      view: view.adsetId ? { group: "adset", campaignId: view.campaignId, adsetId: "" } : null,
    });
  }
  if (view.adsetId) {
    out.push({ label: nombreDe(nombres.adsets, view.adsetId), view: null });
  }
  // La última miga es donde se está: sin enlace.
  const ultima = out[out.length - 1]!;
  out[out.length - 1] = { ...ultima, view: null };
  return out;
}

/** ¿Hay algún filtro que quitar? */
export function tieneFiltros(view: AdsView): boolean {
  return view.campaignId !== "" || view.adsetId !== "";
}
