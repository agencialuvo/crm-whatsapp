import { describe, expect, it } from "vitest";
import {
  applyBoardDelta,
  contribution,
  dropIndex,
  emptyColumns,
  findLead,
  mergeColumnPage,
  moveLocal,
  patchLead,
  placeAt,
  replaceColumn,
  type Columns,
  type DeltaCard,
} from "@/lib/pipeline-state";
import type { BoardLeadDto, StageTotalsDto } from "@/lib/types";

/** 044 — El estado del tablero, como funciones puras. La contraparte SQL: pipeline-tablero-live. */

let n = 0;
function lead(over: Partial<BoardLeadDto> & { id?: string } = {}): BoardLeadDto {
  const i = ++n;
  return {
    id: over.id ?? `lead_${String(i).padStart(3, "0")}`,
    stageId: "s1",
    position: i,
    lastActivityAt: null,
    contact: { id: `ct_${i}`, name: `Cliente ${i}`, phone: null },
    channel: "whatsapp",
    conversationId: null,
    amountCents: null,
    currency: null,
    priority: null,
    lastAutoRule: null,
    ...over,
  };
}

const T0: StageTotalsDto = { count: 0, sumCents: 0, withoutAmount: 0, otherCurrency: 0 };

function board(cols: Record<string, BoardLeadDto[]>, more: string[] = []): Columns {
  const out: Columns = {};
  for (const [id, rows] of Object.entries(cols)) {
    const totals = rows.reduce<StageTotalsDto>((t, l) => {
      const c = contribution(l, "MXN");
      return {
        count: t.count + 1,
        sumCents: t.sumCents + c.sumCents,
        withoutAmount: t.withoutAmount + c.withoutAmount,
        otherCurrency: t.otherCurrency + c.otherCurrency,
      };
    }, T0);
    out[id] = { rows, nextCursor: more.includes(id) ? "cur" : null, totals };
  }
  return out;
}
const ids = (c: Columns, s: string) => c[s]!.rows.map((r) => r.id);

describe("placeAt", () => {
  it("pone el id en el índice, acotado a la columna", () => {
    expect(placeAt(["a", "b", "c"], "x", 0)).toEqual(["x", "a", "b", "c"]);
    expect(placeAt(["a", "b", "c"], "x", 99)).toEqual(["a", "b", "c", "x"]);
    expect(placeAt(["a", "b", "c"], "x", -5)).toEqual(["x", "a", "b", "c"]);
  });
  it("mover uno que ya estaba no lo duplica (mismo lugar, extremos)", () => {
    expect(placeAt(["a", "b", "c"], "b", 1)).toEqual(["a", "b", "c"]);
    expect(placeAt(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(placeAt(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
  });
});

describe("dropIndex", () => {
  const a = lead({ id: "a" });
  const b = lead({ id: "b" });
  const c = lead({ id: "c" });
  const d = lead({ id: "d", stageId: "s2" });
  const cols = board({ s1: [a, b, c], s2: [d] });
  it("soltar sobre una tarjeta la deja en el lugar de esa tarjeta", () => {
    expect(dropIndex(cols, "a", "c")).toEqual({ stageId: "s1", index: 2 });
    expect(dropIndex(cols, "c", "a")).toEqual({ stageId: "s1", index: 0 });
    expect(dropIndex(cols, "a", "d")).toEqual({ stageId: "s2", index: 0 });
  });
  it("soltar sobre la columna la deja al final de lo cargado (sin contar la propia tarjeta)", () => {
    expect(dropIndex(cols, "a", "s1")).toEqual({ stageId: "s1", index: 2 });
    expect(dropIndex(cols, "a", "s2")).toEqual({ stageId: "s2", index: 1 });
  });
  it("un destino desconocido no hace nada", () => {
    expect(dropIndex(cols, "a", "zzz")).toBeNull();
  });
});

describe("moveLocal (movimiento optimista)", () => {
  it("dentro de la misma columna reordena y renumera 0..n-1", () => {
    const [a, b, c] = [lead({ id: "a" }), lead({ id: "b" }), lead({ id: "c" })];
    const out = moveLocal(board({ s1: [a, b, c] }), "a", "s1", 2, "MXN");
    expect(ids(out, "s1")).toEqual(["b", "c", "a"]);
    expect(out.s1!.rows.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(out.s1!.totals.count).toBe(3);
  });

  it("entre columnas: sale de una, entra en otra en su índice y ajusta conteos y sumas", () => {
    const a = lead({ id: "a", amountCents: 1000, currency: "MXN" });
    const b = lead({ id: "b" });
    const x = lead({ id: "x", stageId: "s2", amountCents: 500 });
    const out = moveLocal(board({ s1: [a, b], s2: [x] }), "a", "s2", 0, "MXN");
    expect(ids(out, "s1")).toEqual(["b"]);
    expect(ids(out, "s2")).toEqual(["a", "x"]);
    expect(out.s1!.totals).toMatchObject({ count: 1, sumCents: 0, withoutAmount: 1 });
    expect(out.s2!.totals).toMatchObject({ count: 2, sumCents: 1500 });
    expect(findLead(out, "a")!.lead.stageId).toBe("s2");
  });

  it("una venta en otra moneda no entra a la suma (se cuenta aparte)", () => {
    const a = lead({ id: "a", amountCents: 900, currency: "USD" });
    const out = moveLocal(board({ s1: [a], s2: [] }), "a", "s2", 0, "MXN");
    expect(out.s2!.totals).toMatchObject({ count: 1, sumCents: 0, otherCurrency: 1 });
  });

  it("un id o una columna que no existen no cambian nada", () => {
    const cols = board({ s1: [lead({ id: "a" })] });
    expect(moveLocal(cols, "zzz", "s1", 0, "MXN")).toBe(cols);
    expect(moveLocal(cols, "a", "nope", 0, "MXN")).toBe(cols);
  });
});

describe("patchLead", () => {
  it("cambiar el monto ajusta la suma de la columna sin tocar el conteo", () => {
    const a = lead({ id: "a", amountCents: 1000 });
    const out = patchLead(board({ s1: [a] }), "a", { amountCents: 2500 }, "MXN");
    expect(out.s1!.totals).toMatchObject({ count: 1, sumCents: 2500, withoutAmount: 0 });
    const sin = patchLead(out, "a", { amountCents: null }, "MXN");
    expect(sin.s1!.totals).toMatchObject({ count: 1, sumCents: 0, withoutAmount: 1 });
  });
});

describe("mergeColumnPage / replaceColumn", () => {
  it("añade la página siguiente sin repetir tarjetas y en orden", () => {
    const a = lead({ id: "a", position: 0 });
    const b = lead({ id: "b", position: 1 });
    const c = lead({ id: "c", position: 2 });
    const col = board({ s1: [a, b] }, ["s1"]).s1!;
    const out = mergeColumnPage(col, [b, c], null);
    expect(out.rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(out.nextCursor).toBeNull();
  });
  it("recargar reemplaza lo cargado y ordena por (posición, id)", () => {
    const col = board({ s1: [lead({ id: "a" })] }).s1!;
    const out = replaceColumn(
      col,
      [lead({ id: "z", position: 1 }), lead({ id: "y", position: 1 }), lead({ id: "m", position: 0 })],
      "c2"
    );
    expect(out.rows.map((r) => r.id)).toEqual(["m", "y", "z"]);
    expect(out.nextCursor).toBe("c2");
  });
});

describe("applyBoardDelta", () => {
  const delta = (card: BoardLeadDto, matches = true): DeltaCard => ({ ...card, matches });

  it("una tarjeta que cambió de etapa sale de la vieja y entra en la nueva, en su posición", () => {
    const a = lead({ id: "a", position: 0 });
    const x = lead({ id: "x", stageId: "s2", position: 0 });
    const y = lead({ id: "y", stageId: "s2", position: 5 });
    const cols = board({ s1: [a], s2: [x, y] });
    const out = applyBoardDelta(cols, [delta({ ...a, stageId: "s2", position: 2 })], { s1: T0, s2: { ...T0, count: 3 } });
    expect(ids(out, "s1")).toEqual([]);
    expect(ids(out, "s2")).toEqual(["x", "a", "y"]);
    expect(out.s2!.totals.count).toBe(3); // los totales los manda el servidor
  });

  it("la que deja de cumplir los filtros se retira", () => {
    const a = lead({ id: "a" });
    const out = applyBoardDelta(board({ s1: [a] }), [delta(a, false)], {});
    expect(ids(out, "s1")).toEqual([]);
  });

  it("una que cae MÁS ABAJO de lo cargado (y hay más páginas) no se pinta: llegará con cargar más", () => {
    const a = lead({ id: "a", position: 0 });
    const lejos = lead({ id: "lejos", stageId: "s1", position: 500 });
    const out = applyBoardDelta(board({ s1: [a] }, ["s1"]), [delta(lejos)], {});
    expect(ids(out, "s1")).toEqual(["a"]);
  });

  it("sin más páginas, una nueva entra aunque sea la última", () => {
    const a = lead({ id: "a", position: 0 });
    const nueva = lead({ id: "nueva", position: 9 });
    const out = applyBoardDelta(board({ s1: [a] }), [delta(nueva)], {});
    expect(ids(out, "s1")).toEqual(["a", "nueva"]);
  });

  it("una que ya estaba y cambió de posición se reordena sin duplicarse", () => {
    const [a, b] = [lead({ id: "a", position: 0 }), lead({ id: "b", position: 1 })];
    const out = applyBoardDelta(board({ s1: [a, b] }), [delta({ ...a, position: 5 })], {});
    expect(ids(out, "s1")).toEqual(["b", "a"]);
  });

  it("no pisa la tarjeta que el operador está moviendo (protect)", () => {
    const a = lead({ id: "a", position: 0 });
    const cols = board({ s1: [a], s2: [] });
    const out = applyBoardDelta(cols, [delta({ ...a, stageId: "s2", position: 0 })], {}, { protect: new Set(["a"]) });
    expect(ids(out, "s1")).toEqual(["a"]);
    expect(ids(out, "s2")).toEqual([]);
  });

  it("emptyColumns crea una columna vacía por etapa", () => {
    expect(Object.keys(emptyColumns(["s1", "s2"]))).toEqual(["s1", "s2"]);
  });
});
