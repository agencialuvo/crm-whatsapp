/**
 * Paginación común de todas las tablas y listados.
 *
 * Una sola regla para toda la app: las filas por página son `10 | 25 | 50 | 100 | Todos`, y
 * «Todos» se guarda como `0` (sin tope). Lo comparten el servidor (valida lo que se guarda) y
 * las pantallas (`DataTablePagination` + `useDataTable`).
 */

/** «Todos»: se guarda como 0 y las pantallas lo leen como «sin tope» (`rowsPerPage`). */
export const PAGE_SIZE_ALL = 0;

/** Filas por página permitidas, en el orden del selector. */
export const PAGE_SIZES = [10, 25, 50, 100, PAGE_SIZE_ALL] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/** Densidad por defecto de una tabla que nadie ha tocado. */
export const DEFAULT_PAGE_SIZE: PageSize = 25;

export function isPageSize(n: unknown): n is PageSize {
  return typeof n === "number" && (PAGE_SIZES as readonly number[]).includes(n);
}

/** Las filas que realmente caben por página: «Todos» = sin tope. */
export function rowsPerPage(size: number): number {
  return size === PAGE_SIZE_ALL ? Number.MAX_SAFE_INTEGER : size;
}

/** Texto del selector: `25` → «25 por página», `0` → «Todos». */
export function pageSizeLabel(size: number): string {
  return size === PAGE_SIZE_ALL ? "Todos" : `${size} por página`;
}

export type PageInfo = {
  /** Página actual (desde 1), ya acotada a las que existen. */
  page: number;
  pages: number;
  /** Primera y última fila mostradas (desde 1); 0 y 0 si no hay filas. */
  from: number;
  to: number;
  /** Para `slice(offset, offset + limit)` o para pedirlo al servidor. */
  offset: number;
  limit: number;
};

/** Dónde cae una página de `total` filas con `size` filas por página (`page` desde 1). */
export function pageInfo(total: number, page: number, size: number): PageInfo {
  const limit = rowsPerPage(size);
  const safeTotal = Math.max(0, Math.floor(total));
  const pages = Math.max(1, Math.ceil(safeTotal / limit));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const offset = (current - 1) * limit;
  return {
    page: current,
    pages,
    from: safeTotal === 0 ? 0 : offset + 1,
    to: Math.min(safeTotal, offset + limit),
    offset,
    limit,
  };
}

/** Los números de página a pintar; `null` es un salto («…»). Siempre la primera, la última y las vecinas. */
export function pageWindow(current: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, current - 1, current, current + 1]);
  const list = [...keep].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  list.forEach((n, i) => {
    const prev = list[i - 1];
    if (prev !== undefined && n - prev > 1) out.push(null);
    out.push(n);
  });
  return out;
}
