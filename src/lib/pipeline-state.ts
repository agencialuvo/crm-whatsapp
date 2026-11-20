import type { BoardLeadDto, StageTotalsDto } from "@/lib/types";

/**
 * 044 — El estado del tablero del Pipeline, como funciones puras (sin React ni red).
 *
 * Misma idea que `inbox-state.ts` (042): lo delicado —dónde cae una tarjeta, cómo se ajustan los totales,
 * qué hace un delta— se prueba sin pantalla. El componente solo guarda el resultado.
 *
 * Una columna guarda las tarjetas CARGADAS (siempre el principio de la columna, en orden de pantalla), el
 * cursor para pedir más y los totales que dice el servidor (de TODA la columna, con los filtros aplicados).
 */

export type Column = {
  rows: BoardLeadDto[];
  nextCursor: string | null;
  totals: StageTotalsDto;
};

export type Columns = Record<string, Column>;

export const EMPTY_TOTALS: StageTotalsDto = { count: 0, sumCents: 0, withoutAmount: 0, otherCurrency: 0 };

/** El orden de pantalla de una columna: `(position, id)`, el mismo del servidor. */
export const byPosition = (a: Pick<BoardLeadDto, "position" | "id">, b: Pick<BoardLeadDto, "position" | "id">): number =>
  a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Saca `id` de la lista (si estaba) y lo pone en `index`, acotado a [0, n]. */
export function placeAt(ids: readonly string[], id: string, index: number): string[] {
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : 0, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Lo que una tarjeta aporta a los totales de su columna. */
export function contribution(lead: Pick<BoardLeadDto, "amountCents" | "currency">, businessCurrency: string): StageTotalsDto {
  if (lead.amountCents === null) return { count: 1, sumCents: 0, withoutAmount: 1, otherCurrency: 0 };
  if ((lead.currency ?? businessCurrency) !== businessCurrency) {
    return { count: 1, sumCents: 0, withoutAmount: 0, otherCurrency: 1 };
  }
  return { count: 1, sumCents: lead.amountCents, withoutAmount: 0, otherCurrency: 0 };
}

const sumar = (t: StageTotalsDto, c: StageTotalsDto, signo: 1 | -1): StageTotalsDto => ({
  count: Math.max(0, t.count + signo * c.count),
  sumCents: t.sumCents + signo * c.sumCents,
  withoutAmount: Math.max(0, t.withoutAmount + signo * c.withoutAmount),
  otherCurrency: Math.max(0, t.otherCurrency + signo * c.otherCurrency),
});

/** Una columna vacía por etapa. */
export function emptyColumns(stageIds: readonly string[]): Columns {
  return Object.fromEntries(stageIds.map((id) => [id, { rows: [], nextCursor: null, totals: EMPTY_TOTALS }]));
}

/** Dónde está una tarjeta ahora. */
export function findLead(columns: Columns, leadId: string): { stageId: string; index: number; lead: BoardLeadDto } | null {
  for (const [stageId, col] of Object.entries(columns)) {
    const index = col.rows.findIndex((r) => r.id === leadId);
    if (index >= 0) return { stageId, index, lead: col.rows[index]! };
  }
  return null;
}

/** Reescribe `position = índice` en lo cargado: así el orden local coincide con lo que el servidor renumera. */
const renumerar = (rows: BoardLeadDto[]): BoardLeadDto[] => rows.map((r, i) => (r.position === i ? r : { ...r, position: i }));

/**
 * El índice donde cae una tarjeta soltada sobre `overId` (otra tarjeta o una columna). Se calcula sobre la
 * columna destino SIN la tarjeta arrastrada (la misma semántica de `placeAt`): soltar sobre una tarjeta
 * la deja en el lugar de esa tarjeta; soltar sobre la columna la deja al final de lo cargado.
 */
export function dropIndex(columns: Columns, activeId: string, overId: string): { stageId: string; index: number } | null {
  if (columns[overId]) {
    const rest = columns[overId]!.rows.filter((r) => r.id !== activeId);
    return { stageId: overId, index: rest.length };
  }
  const over = findLead(columns, overId);
  if (!over) return null;
  return { stageId: over.stageId, index: over.index };
}

/**
 * Movimiento OPTIMISTA: saca la tarjeta de su columna, la pone en `index` de la destino y ajusta los totales
 * de ambas. El servidor tiene la última palabra (renumera y manda `pipeline.reordered`).
 */
export function moveLocal(
  columns: Columns,
  leadId: string,
  toStageId: string,
  index: number,
  businessCurrency: string
): Columns {
  const from = findLead(columns, leadId);
  const dest = columns[toStageId];
  if (!from || !dest) return columns;
  const moved: BoardLeadDto = { ...from.lead, stageId: toStageId };
  const next: Columns = { ...columns };

  if (from.stageId === toStageId) {
    const ids = placeAt(dest.rows.map((r) => r.id), leadId, index);
    const byId = new Map(dest.rows.map((r) => [r.id, r]));
    next[toStageId] = { ...dest, rows: renumerar(ids.map((id) => byId.get(id)!)) };
    return next;
  }

  const src = columns[from.stageId]!;
  const c = contribution(from.lead, businessCurrency);
  next[from.stageId] = {
    ...src,
    rows: renumerar(src.rows.filter((r) => r.id !== leadId)),
    totals: sumar(src.totals, c, -1),
  };
  const rest = dest.rows;
  const at = Math.max(0, Math.min(index, rest.length));
  next[toStageId] = {
    ...dest,
    rows: renumerar([...rest.slice(0, at), moved, ...rest.slice(at)]),
    totals: sumar(dest.totals, c, 1),
  };
  return next;
}

/** Cambia campos de una tarjeta (monto, prioridad) y ajusta los totales si cambió el monto. */
export function patchLead(
  columns: Columns,
  leadId: string,
  patch: Partial<Pick<BoardLeadDto, "amountCents" | "currency" | "priority">>,
  businessCurrency: string
): Columns {
  const at = findLead(columns, leadId);
  if (!at) return columns;
  const col = columns[at.stageId]!;
  const updated = { ...at.lead, ...patch };
  const rows = col.rows.map((r) => (r.id === leadId ? updated : r));
  const totals = sumar(sumar(col.totals, contribution(at.lead, businessCurrency), -1), contribution(updated, businessCurrency), 1);
  return { ...columns, [at.stageId]: { ...col, rows, totals: { ...totals, count: col.totals.count } } };
}

/** Añade una página (la siguiente de la columna) sin repetir tarjetas ya cargadas. */
export function mergeColumnPage(col: Column, rows: BoardLeadDto[], nextCursor: string | null): Column {
  const have = new Set(col.rows.map((r) => r.id));
  const extra = rows.filter((r) => !have.has(r.id));
  return { ...col, rows: [...col.rows, ...extra].sort(byPosition), nextCursor };
}

/** Reemplaza lo cargado de una columna (tras recargarla) conservando el cursor nuevo. */
export function replaceColumn(col: Column, rows: BoardLeadDto[], nextCursor: string | null, totals?: StageTotalsDto): Column {
  return { rows: [...rows].sort(byPosition), nextCursor, totals: totals ?? col.totals };
}

/** ¿Cae la tarjeta dentro de lo cargado de la columna (o ya no hay más páginas)? Si no, llegará con «cargar más». */
function caeEnLoCargado(col: Column, lead: Pick<BoardLeadDto, "position" | "id">): boolean {
  if (col.nextCursor === null) return true;
  const last = col.rows.at(-1);
  if (!last) return false;
  return byPosition(lead, last) <= 0;
}

export type DeltaCard = BoardLeadDto & { matches: boolean };

/**
 * Aplica lo que cambió: cada tarjeta que sigue cumpliendo los filtros se actualiza o entra (si cae dentro de
 * lo cargado); la que dejó de cumplirlos o se movió a una zona aún no cargada se retira. Los totales los
 * manda el servidor. Las tarjetas de `protect` (las que el operador arrastra o guarda ahora mismo) no se tocan.
 */
export function applyBoardDelta(
  columns: Columns,
  changed: readonly DeltaCard[],
  totals: Record<string, StageTotalsDto>,
  opts: { protect?: ReadonlySet<string> } = {}
): Columns {
  const next: Columns = Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, { ...v, rows: [...v.rows] }]));
  for (const card of changed) {
    if (opts.protect?.has(card.id)) continue; // el operador lo está arrastrando o guardando ahora mismo
    const { matches, ...lead } = card;
    const current = findLead(next, lead.id);
    if (current) next[current.stageId]!.rows.splice(current.index, 1);
    const col = next[lead.stageId];
    if (!matches || !col) continue;
    if (!caeEnLoCargado(col, lead)) continue;
    col.rows.push(lead);
    col.rows.sort(byPosition);
  }
  for (const [stageId, t] of Object.entries(totals)) {
    if (next[stageId]) next[stageId] = { ...next[stageId]!, totals: t };
  }
  return next;
}
