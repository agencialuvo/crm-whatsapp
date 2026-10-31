"use client";

import { useCallback, useMemo, useState } from "react";
import type { DataTablePaginationProps } from "@/components/ui/data-table-pagination";
import { useTablePageSize } from "@/components/ui/use-table-page-size";
import { DEFAULT_PAGE_SIZE, pageInfo, type PageInfo } from "@/lib/pagination";

export type UseDataTableOptions = {
  /**
   * Nombre estable de la vista («clientes», «caja-ventas»…): con él se recuerdan las filas por
   * página de cada persona, y cada tabla recuerda las suyas. Minúsculas, números, `_` y `-`.
   */
  view: string;
  /** Filas por página mientras nadie haya elegido otras. */
  defaultPageSize?: number;
  /**
   * Cambia cuando cambian los filtros o la búsqueda: la tabla vuelve a la primera página.
   * Sin él, solo se acota la página si la lista se encoge.
   */
  resetKey?: string;
};

export type DataTable<T> = {
  /** Las filas de la página actual (todas, con «Todos»). */
  rows: T[];
  /** Filas de TODAS las páginas: lo que se exporta o se selecciona en bloque. */
  allRows: readonly T[];
  info: PageInfo;
  /** Para `<DataTablePagination {...table.pagination} />`. */
  pagination: Pick<DataTablePaginationProps, "page" | "pageSize" | "total" | "onPageChange" | "onPageSizeChange">;
  setPage: (page: number) => void;
};

/**
 * Patrón base de toda tabla: recibe la lista YA filtrada y devuelve la página a pintar y lo que
 * necesita el pie estándar. La densidad (filas por página) se recuerda por persona y por vista;
 * el filtrado sigue siendo de cada pantalla (se hace antes, con `useMemo`).
 *
 *   const table = useDataTable(filtered, { view: "gastos", resetKey: `${kind}|${query}` });
 *   …table.rows.map(…)…
 *   <DataTablePagination {...table.pagination} noun={{ one: "gasto", other: "gastos" }} />
 */
export function useDataTable<T>(
  allRows: readonly T[],
  { view, defaultPageSize = DEFAULT_PAGE_SIZE, resetKey = "" }: UseDataTableOptions
): DataTable<T> {
  const [pageSize, setPageSize] = useTablePageSize(view, defaultPageSize);
  // La página guarda con qué filtros se eligió: si cambian, vale la primera sin efectos ni parpadeo.
  const [chosen, setChosen] = useState({ page: 1, key: resetKey });
  const wanted = chosen.key === resetKey ? chosen.page : 1;

  const info = useMemo(() => pageInfo(allRows.length, wanted, pageSize), [allRows.length, wanted, pageSize]);
  const rows = useMemo(
    () => allRows.slice(info.offset, info.offset + Math.min(info.limit, allRows.length)),
    [allRows, info.offset, info.limit]
  );

  const setPage = useCallback((page: number) => setChosen({ page, key: resetKey }), [resetKey]);
  const onPageSizeChange = useCallback(
    (size: number) => {
      setPageSize(size);
      setChosen({ page: 1, key: resetKey });
    },
    [setPageSize, resetKey]
  );

  return {
    rows,
    allRows,
    info,
    pagination: { page: info.page, pageSize, total: allRows.length, onPageChange: setPage, onPageSizeChange },
    setPage,
  };
}
