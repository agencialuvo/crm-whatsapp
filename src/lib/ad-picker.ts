import { adScopeOf, type AdReferralConfig, type AdScopeLevel } from "@/lib/automation";

/**
 * 047 — El selector del disparador «Llegó de un anuncio» (Campaña ▸ Conjunto ▸ Anuncio), como funciones PURAS: el
 * árbol, su aplanado para el teclado, el resumen de lo elegido y los cursores del endpoint. La UI
 * (`ad-trigger-picker.tsx`) y el servidor (`ad-options.ts`) comparten estos contratos; aquí no hay red ni React,
 * para probarlos con tablas de casos.
 */

export type CampaignNode = {
  level: "campaign";
  id: string;
  name: string | null;
  adsetCount: number;
  adCount: number;
  active: boolean;
};

export type AdsetNode = {
  level: "adset";
  id: string;
  name: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adCount: number;
  active: boolean;
};

export type AdNode = {
  level: "ad";
  id: string;
  name: string | null;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  /** `effective_status` de Meta (ACTIVE, PAUSED, CAMPAIGN_PAUSED…). */
  status: string | null;
  /** Ruta LOCAL de la copia del creativo (`/api/medios/<id>/archivo`); nunca una URL de Meta (caducan). */
  thumbUrl: string | null;
};

export type PickerNode = CampaignNode | AdsetNode | AdNode;

/** Un anuncio que ya trajo gente pero que el catálogo de la Marketing API no tiene (sin cuenta conectada). */
export type LooseAd = { adId: string; headline: string | null };

export type AdOptionsMeta = {
  /** ¿Hay credenciales de la Marketing API guardadas? Sin ellas solo se ofrece «Un anuncio». */
  connector: boolean;
  /** ¿El catálogo tiene al menos un anuncio sincronizado? */
  hasCatalog: boolean;
  /** La última vez que el catálogo se sincronizó (ISO), o null. */
  syncedAt: string | null;
};

export type AdOptionsPage = {
  items: PickerNode[];
  nextCursor: string | null;
};

export type AdOptionsRoot = AdOptionsPage & { meta: AdOptionsMeta; loose: LooseAd[] };

/* ---------- Miniatura ---------- */

export const adThumbUrl = (assetId: string | null | undefined): string | null => (assetId ? `/api/medios/${assetId}/archivo` : null);

/** Solo una ruta local de medios es una miniatura válida: nada de URLs de terceros. */
export const isLocalThumb = (url: string | null | undefined): boolean => !!url && /^\/api\/medios\/[A-Za-z0-9_-]+\/archivo$/.test(url);

/* ---------- Cursor ---------- */

export type PickerCursor = { r: number; n: string; id: string };

export function encodeCursor(c: PickerCursor): string {
  return encodeURIComponent(JSON.stringify(c));
}

export function decodeCursor(raw: string | null | undefined): PickerCursor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as Partial<PickerCursor>;
    if ((v.r === 0 || v.r === 1) && typeof v.n === "string" && typeof v.id === "string") return { r: v.r, n: v.n, id: v.id };
  } catch {
    /* cursor inválido: se ignora y se pide desde el principio */
  }
  return null;
}

/* ---------- Nodos y configuración ---------- */

export const nodeKey = (n: Pick<PickerNode, "level" | "id">): string => `${n.level}:${n.id}`;

/** El `trigger_config` que produce elegir este nodo: solo el ID, nunca un nombre. */
export function configFor(node: Pick<PickerNode, "level" | "id">): AdReferralConfig {
  if (node.level === "ad") return { sourceId: node.id };
  if (node.level === "adset") return { adsetId: node.id };
  return { campaignId: node.id };
}

export function nodeMatchesConfig(node: Pick<PickerNode, "level" | "id">, cfg: AdReferralConfig): boolean {
  const { level, id } = adScopeOf(cfg);
  return level !== "any" && level === node.level && id === node.id;
}

export const LEVEL_LABEL: Record<AdScopeLevel, string> = {
  any: "Cualquier anuncio",
  ad: "Anuncio",
  adset: "Conjunto",
  campaign: "Campaña",
};

export const hasChildren = (n: PickerNode): boolean => n.level !== "ad";

/** «Campaña › Conjunto» del nodo (lo que ya sabe de su ruta). */
export function pathLabel(n: PickerNode): string {
  if (n.level === "campaign") return "";
  if (n.level === "adset") return n.campaignName ?? "";
  return [n.campaignName, n.adsetName].filter(Boolean).join(" › ");
}

export const nodeTitle = (n: PickerNode): string => n.name?.trim() || `ID ${n.id}`;

/** Cuántos anuncios cubre elegir este nodo (1 para un anuncio). */
export const coverage = (n: PickerNode): number => (n.level === "ad" ? 1 : n.adCount);

export function coverageLabel(n: PickerNode): string {
  if (n.level === "ad") return "";
  const c = n.adCount;
  return `${c} ${c === 1 ? "anuncio" : "anuncios"}`;
}

/** «Toda la campaña (12 anuncios)», «Todo el conjunto (3 anuncios)»; para un anuncio, vacío. */
export function chooseLabel(n: PickerNode): string {
  if (n.level === "campaign") return `Toda la campaña (${coverageLabel(n)})`;
  if (n.level === "adset") return `Todo el conjunto (${coverageLabel(n)})`;
  return "";
}

/** Estado en español de un anuncio (de `effective_status`); null si no hay dato. */
export function statusLabel(status: string | null | undefined): { label: string; active: boolean } | null {
  if (!status) return null;
  if (status === "ACTIVE") return { label: "Activo", active: true };
  if (status === "PAUSED" || status === "CAMPAIGN_PAUSED" || status === "ADSET_PAUSED") return { label: "Pausado", active: false };
  if (status === "ARCHIVED" || status === "DELETED") return { label: "Archivado", active: false };
  return { label: status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " "), active: false };
}

/* ---------- Resumen de lo elegido ---------- */

export type SelectionSummary = {
  level: AdScopeLevel;
  id: string | null;
  title: string;
  subtitle: string;
  thumbUrl: string | null;
  /** El valor guardado no está (todavía) en el catálogo: se conserva y se muestra con su ID. */
  orphan: boolean;
};

/** Lo que muestra el botón del selector: el nodo resuelto (nombres VIVOS del catálogo) o el ID si no se encontró. */
export function summarizeSelection(cfg: AdReferralConfig, resolved: PickerNode | null): SelectionSummary {
  const { level, id } = adScopeOf(cfg);
  if (level === "any") return { level, id: null, title: "Cualquier anuncio", subtitle: "Se activa con cualquier anuncio", thumbUrl: null, orphan: false };
  if (!resolved) {
    const what = level === "ad" ? "Anuncio" : level === "adset" ? "Conjunto" : "Campaña";
    return { level, id, title: `${what} ${id}`, subtitle: "Aún no está sincronizado desde Meta", thumbUrl: null, orphan: true };
  }
  const cover = resolved.level === "ad" ? "" : `Todos los anuncios de ${resolved.level === "campaign" ? "la campaña" : "el conjunto"} (${coverageLabel(resolved)})`;
  const path = pathLabel(resolved);
  return {
    level,
    id,
    title: nodeTitle(resolved),
    subtitle: [cover, path].filter(Boolean).join(" · ") || `ID ${resolved.id}`,
    thumbUrl: resolved.level === "ad" ? resolved.thumbUrl : null,
    orphan: false,
  };
}

/* ---------- El árbol visible (para el teclado) ---------- */

export type ChildrenState = { items: PickerNode[]; nextCursor: string | null; loading: boolean; error: boolean };

export type VisibleRow = {
  key: string;
  node: PickerNode;
  depth: 0 | 1 | 2;
  parentKey: string | null;
  expandable: boolean;
  expanded: boolean;
};

/** Aplana el árbol según lo desplegado: la lista de filas que se ven, en orden. */
export function flattenVisible(
  roots: readonly PickerNode[],
  children: Readonly<Record<string, ChildrenState | undefined>>,
  expanded: ReadonlySet<string>
): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (nodes: readonly PickerNode[], depth: 0 | 1 | 2, parentKey: string | null) => {
    for (const node of nodes) {
      const key = nodeKey(node);
      const isOpen = hasChildren(node) && expanded.has(key);
      out.push({ key, node, depth, parentKey, expandable: hasChildren(node), expanded: isOpen });
      if (isOpen) walk(children[key]?.items ?? [], (depth + 1) as 1 | 2, key);
    }
  };
  walk(roots, 0, null);
  return out;
}

export type KeyOutcome = { index: number; action: "toggle" | "select" | "close" | null };

/**
 * El teclado del árbol (WAI-ARIA tree): ↑ ↓ mueven, → despliega (o baja al primer hijo), ← pliega (o sube al padre),
 * Enter/espacio elige, Home/End saltan, Esc cierra.
 */
export function nextFocus(rows: readonly VisibleRow[], index: number, key: string): KeyOutcome {
  const last = rows.length - 1;
  if (last < 0) return { index: 0, action: key === "Escape" ? "close" : null };
  const i = Math.min(Math.max(index, 0), last);
  const row = rows[i]!;
  switch (key) {
    case "ArrowDown":
      return { index: Math.min(i + 1, last), action: null };
    case "ArrowUp":
      return { index: Math.max(i - 1, 0), action: null };
    case "Home":
      return { index: 0, action: null };
    case "End":
      return { index: last, action: null };
    case "ArrowRight":
      if (row.expandable && !row.expanded) return { index: i, action: "toggle" };
      if (row.expandable && row.expanded && rows[i + 1]?.parentKey === row.key) return { index: i + 1, action: null };
      return { index: i, action: null };
    case "ArrowLeft": {
      if (row.expandable && row.expanded) return { index: i, action: "toggle" };
      const parent = rows.findIndex((r) => r.key === row.parentKey);
      return { index: parent >= 0 ? parent : i, action: null };
    }
    case "Enter":
    case " ":
      return { index: i, action: "select" };
    case "Escape":
      return { index: i, action: "close" };
    default:
      return { index: i, action: null };
  }
}

/** Une una página nueva a la lista sin repetir elementos (cargar más). */
export function appendUnique(current: readonly PickerNode[], more: readonly PickerNode[]): PickerNode[] {
  const seen = new Set(current.map(nodeKey));
  return [...current, ...more.filter((n) => !seen.has(nodeKey(n)))];
}

/** Cuánto hace de la última sincronización: «hace 3 h», «hace 12 min», «hace un momento»; null si no hay. */
export function freshnessLabel(syncedAt: string | null, now: Date = new Date()): string | null {
  if (!syncedAt) return null;
  const ms = now.getTime() - new Date(syncedAt).getTime();
  if (!Number.isFinite(ms)) return null;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} días`;
}
