import { describe, expect, it } from "vitest";
import {
  appendUnique,
  chooseLabel,
  configFor,
  coverageLabel,
  decodeCursor,
  encodeCursor,
  flattenVisible,
  freshnessLabel,
  isLocalThumb,
  nextFocus,
  nodeKey,
  nodeMatchesConfig,
  nodeTitle,
  pathLabel,
  statusLabel,
  summarizeSelection,
  type AdNode,
  type AdsetNode,
  type CampaignNode,
  type ChildrenState,
  type PickerNode,
} from "@/lib/ad-picker";

/**
 * 047 — La lógica del selector en árbol (Campaña ▸ Conjunto ▸ Anuncio), pura: cursores, configuración que se guarda
 * (solo IDs), resumen con nombre vivo, aplanado del árbol y teclado.
 */

const camp = (id: string, name: string | null = `Campaña ${id}`): CampaignNode => ({ level: "campaign", id, name, adsetCount: 2, adCount: 5, active: true });
const set = (id: string, campaignId = "C1"): AdsetNode => ({ level: "adset", id, name: `Conjunto ${id}`, campaignId, campaignName: "Campaña C1", adCount: 3, active: false });
const ad = (id: string, over: Partial<AdNode> = {}): AdNode => ({
  level: "ad",
  id,
  name: `Anuncio ${id}`,
  adsetId: "S1",
  adsetName: "Conjunto S1",
  campaignId: "C1",
  campaignName: "Campaña C1",
  status: "ACTIVE",
  thumbUrl: "/api/medios/med_abc/archivo",
  ...over,
});

describe("cursor", () => {
  it("ida y vuelta, con acentos y símbolos", () => {
    const c = { r: 1, n: "campaña verano & más", id: "123" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
  it.each([null, undefined, "", "no-es-json", encodeURIComponent(JSON.stringify({ r: 7, n: "x", id: "1" })), encodeURIComponent(JSON.stringify({ r: 0, n: 5, id: "1" }))])("un cursor inválido (%s) se ignora", (raw) => {
    expect(decodeCursor(raw as string | null | undefined)).toBeNull();
  });
});

describe("lo que se guarda: solo IDs", () => {
  it("configFor", () => {
    expect(configFor(ad("A1"))).toEqual({ sourceId: "A1" });
    expect(configFor(set("S1"))).toEqual({ adsetId: "S1" });
    expect(configFor(camp("C1"))).toEqual({ campaignId: "C1" });
    // nunca un nombre
    for (const n of [ad("A1"), set("S1"), camp("C1")]) expect(JSON.stringify(configFor(n))).not.toMatch(/Campaña|Conjunto|Anuncio/);
  });
  it("nodeMatchesConfig marca lo elegido por nivel e ID", () => {
    expect(nodeMatchesConfig(camp("C1"), { campaignId: "C1" })).toBe(true);
    expect(nodeMatchesConfig(camp("C1"), { adsetId: "C1" })).toBe(false); // mismo ID, otro nivel
    expect(nodeMatchesConfig(ad("A1"), {})).toBe(false);
  });
});

describe("textos", () => {
  it("título con respaldo al ID, ruta y cobertura", () => {
    expect(nodeTitle(camp("C9", null))).toBe("ID C9");
    expect(pathLabel(ad("A1"))).toBe("Campaña C1 › Conjunto S1");
    expect(pathLabel(set("S1"))).toBe("Campaña C1");
    expect(pathLabel(camp("C1"))).toBe("");
    expect(coverageLabel({ ...camp("C1"), adCount: 1 })).toBe("1 anuncio");
    expect(chooseLabel(camp("C1"))).toBe("Toda la campaña (5 anuncios)");
    expect(chooseLabel(set("S1"))).toBe("Todo el conjunto (3 anuncios)");
    expect(chooseLabel(ad("A1"))).toBe("");
  });
  it("estado en español", () => {
    expect(statusLabel("ACTIVE")).toEqual({ label: "Activo", active: true });
    expect(statusLabel("CAMPAIGN_PAUSED")).toEqual({ label: "Pausado", active: false });
    expect(statusLabel("ARCHIVED")?.label).toBe("Archivado");
    expect(statusLabel(null)).toBeNull();
  });
  it("frescura del catálogo", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    expect(freshnessLabel(null, now)).toBeNull();
    expect(freshnessLabel("2026-11-18T11:59:50Z", now)).toBe("hace un momento");
    expect(freshnessLabel("2026-11-18T11:30:00Z", now)).toBe("hace 30 min");
    expect(freshnessLabel("2026-11-18T06:00:00Z", now)).toBe("hace 6 h");
    expect(freshnessLabel("2026-11-14T12:00:00Z", now)).toBe("hace 4 días");
    expect(freshnessLabel("basura", now)).toBeNull();
  });
});

describe("miniaturas: solo la copia local", () => {
  it.each([
    ["/api/medios/med_abc/archivo", true],
    ["/api/medios/abc-123_X/archivo", true],
    ["https://scontent.xx.fbcdn.net/v/t45/x.jpg?oh=1", false],
    ["http://evil.com/api/medios/a/archivo", false],
    ["//evil.com/api/medios/a/archivo", false],
    ["/api/medios/../secreto/archivo", false],
    ["javascript:alert(1)", false],
    [null, false],
  ])("%s → %s", (u, ok) => expect(isLocalThumb(u as string | null)).toBe(ok));
});

describe("resumen de lo elegido (nombre VIVO)", () => {
  it("cualquiera", () => {
    expect(summarizeSelection({}, null)).toMatchObject({ level: "any", title: "Cualquier anuncio", orphan: false });
  });
  it("un anuncio resuelto muestra su nombre, su ruta y su miniatura", () => {
    expect(summarizeSelection({ sourceId: "A1" }, ad("A1"))).toMatchObject({
      level: "ad",
      title: "Anuncio A1",
      subtitle: "Campaña C1 › Conjunto S1",
      thumbUrl: "/api/medios/med_abc/archivo",
      orphan: false,
    });
  });
  it("un renombre en Meta se ve sin tocar el flujo", () => {
    const antes = summarizeSelection({ campaignId: "C1" }, camp("C1", "Verano"));
    const despues = summarizeSelection({ campaignId: "C1" }, camp("C1", "Verano 2027"));
    expect(antes.title).toBe("Verano");
    expect(despues.title).toBe("Verano 2027");
    expect(despues.subtitle).toContain("Todos los anuncios de la campaña (5 anuncios)");
  });
  it("lo que no está en el catálogo se conserva y se marca (nunca se borra)", () => {
    expect(summarizeSelection({ adsetId: "S9" }, null)).toMatchObject({ level: "adset", id: "S9", title: "Conjunto S9", orphan: true });
    expect(summarizeSelection({ campaignId: "C9" }, null).orphan).toBe(true);
  });
});

describe("árbol visible y teclado", () => {
  const roots: PickerNode[] = [camp("C1"), camp("C2")];
  const children: Record<string, ChildrenState> = {
    "campaign:C1": { items: [set("S1"), set("S2")], nextCursor: null, loading: false, error: false },
    "adset:S1": { items: [ad("A1"), ad("A2")], nextCursor: null, loading: false, error: false },
  };

  it("solo aparece lo desplegado, en orden y con su profundidad", () => {
    expect(flattenVisible(roots, children, new Set()).map((r) => r.key)).toEqual(["campaign:C1", "campaign:C2"]);
    const rows = flattenVisible(roots, children, new Set(["campaign:C1", "adset:S1"]));
    expect(rows.map((r) => `${r.depth}:${r.key}`)).toEqual(["0:campaign:C1", "1:adset:S1", "2:ad:A1", "2:ad:A2", "1:adset:S2", "0:campaign:C2"]);
    expect(rows[0]).toMatchObject({ expandable: true, expanded: true });
    expect(rows[2]).toMatchObject({ expandable: false, parentKey: "adset:S1" });
  });
  it("un nodo desplegado sin hijos cargados no rompe", () => {
    expect(flattenVisible(roots, {}, new Set(["campaign:C1"])).map((r) => r.key)).toEqual(["campaign:C1", "campaign:C2"]);
  });

  const rows = flattenVisible(roots, children, new Set(["campaign:C1"]));
  // C1 (abierta) · S1 · S2 · C2
  it("↑ ↓ Home End", () => {
    expect(nextFocus(rows, 0, "ArrowDown")).toEqual({ index: 1, action: null });
    expect(nextFocus(rows, 3, "ArrowDown")).toEqual({ index: 3, action: null });
    expect(nextFocus(rows, 0, "ArrowUp")).toEqual({ index: 0, action: null });
    expect(nextFocus(rows, 1, "Home")).toEqual({ index: 0, action: null });
    expect(nextFocus(rows, 1, "End")).toEqual({ index: 3, action: null });
  });
  it("→ despliega; ya desplegado baja al primer hijo; ← pliega o sube al padre", () => {
    const closed = flattenVisible(roots, children, new Set());
    expect(nextFocus(closed, 0, "ArrowRight")).toEqual({ index: 0, action: "toggle" });
    expect(nextFocus(rows, 0, "ArrowRight")).toEqual({ index: 1, action: null });
    expect(nextFocus(rows, 0, "ArrowLeft")).toEqual({ index: 0, action: "toggle" });
    expect(nextFocus(rows, 1, "ArrowLeft")).toEqual({ index: 0, action: null });
    // un anuncio (hoja) no se despliega
    const leaf = flattenVisible(roots, children, new Set(["campaign:C1", "adset:S1"]));
    expect(nextFocus(leaf, 2, "ArrowRight")).toEqual({ index: 2, action: null });
  });
  it("Enter y espacio eligen; Escape cierra; otra tecla no hace nada; lista vacía no revienta", () => {
    expect(nextFocus(rows, 2, "Enter")).toEqual({ index: 2, action: "select" });
    expect(nextFocus(rows, 2, " ")).toEqual({ index: 2, action: "select" });
    expect(nextFocus(rows, 2, "Escape")).toEqual({ index: 2, action: "close" });
    expect(nextFocus(rows, 2, "a")).toEqual({ index: 2, action: null });
    expect(nextFocus([], 0, "ArrowDown")).toEqual({ index: 0, action: null });
    expect(nextFocus([], 0, "Escape")).toEqual({ index: 0, action: "close" });
    expect(nextFocus(rows, 99, "ArrowUp").index).toBe(2); // índice fuera de rango se acota
  });
});

describe("cargar más", () => {
  it("no repite elementos ya cargados", () => {
    const a = [camp("C1"), camp("C2")];
    const out = appendUnique(a, [camp("C2"), camp("C3")]);
    expect(out.map(nodeKey)).toEqual(["campaign:C1", "campaign:C2", "campaign:C3"]);
  });
  it("el mismo ID en niveles distintos no se confunde", () => {
    expect(appendUnique([camp("X")], [set("X")]).length).toBe(2);
  });
});
