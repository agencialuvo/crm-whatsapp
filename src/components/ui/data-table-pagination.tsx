"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/search-select";
import { PAGE_SIZES, pageInfo, pageSizeLabel, pageWindow, rowsPerPage, type PageInfo } from "@/lib/pagination";
import { cn } from "@/lib/utils";

const SIZE_OPTIONS = PAGE_SIZES.map((n) => ({ value: String(n), label: pageSizeLabel(n) }));

export type DataTableNoun = { one: string; other: string };
const DEFAULT_NOUN: DataTableNoun = { one: "registro", other: "registros" };

export type DataTablePaginationProps = {
  /** Página actual, desde 1. */
  page: number;
  /** Filas por página (`10 | 25 | 50 | 100 | 0` = Todos). */
  pageSize: number;
  /** Cuántas filas hay EN TOTAL (no solo en esta página). */
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  /** Cómo se llaman las filas: «turno» / «turnos». Por defecto «registro» / «registros». */
  noun?: DataTableNoun;
  /** Nombre accesible del pie («Paginación de clientes»). */
  label?: string;
  /** Tope de filas por consulta cuando el servidor no entrega «Todos» de una vez. */
  maxPerPage?: number;
  /** Mientras se trae una página nueva. */
  disabled?: boolean;
  className?: string;
};

/** «Mostrando X a Y de Z registros». */
function ShowingCount({ info, total, noun }: { info: PageInfo; total: number; noun: DataTableNoun }) {
  return (
    <p className="text-xs text-text-3">
      Mostrando <span className="tabular-nums">{info.from}</span> a <span className="tabular-nums">{info.to}</span> de{" "}
      <span className="tabular-nums">{total}</span> {total === 1 ? noun.one : noun.other}
    </p>
  );
}

/**
 * REGLA DEL SISTEMA — barra SUPERIOR de toda tabla o listado con filas: a la izquierda «Mostrando X a Y
 * de Z registros» y, a la derecha, el selector de filas por página (`10 | 25 | 50 | 100 | Todos`, con
 * buscador como todo desplegable). Va justo encima de la tabla; el pie (`DataTablePagination`) repite
 * el conteo y trae los botones de página.
 */
export function DataTableToolbar({
  page,
  pageSize,
  total,
  onPageSizeChange,
  noun = DEFAULT_NOUN,
  maxPerPage,
  disabled,
  className,
}: Pick<
  DataTablePaginationProps,
  "page" | "pageSize" | "total" | "onPageSizeChange" | "noun" | "maxPerPage" | "disabled" | "className"
>) {
  if (total <= 0) return null;
  const info = pageInfo(total, page, maxPerPage ? Math.min(rowsPerPage(pageSize), maxPerPage) : pageSize);
  return (
    <div className={cn("mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2", className)}>
      <ShowingCount info={info} total={total} noun={noun} />
      <SearchSelect
        value={String(pageSize)}
        onChange={(v) => onPageSizeChange(Number(v))}
        options={SIZE_OPTIONS}
        ariaLabel="Filas por página"
        searchPlaceholder="Buscar…"
        disabled={disabled}
        className="ml-auto w-40"
      />
    </div>
  );
}

/**
 * REGLA DEL SISTEMA — pie de toda tabla o listado con filas: repite «Mostrando X a Y de Z registros» a
 * la izquierda y, si hay más de una página, los botones para moverse a la derecha. Va con la barra
 * superior (`DataTableToolbar`), que tiene el selector de filas por página.
 *
 * Solo pinta; el estado vive en `useDataTable` (listas ya cargadas en el navegador) o en la
 * pantalla (listas que se piden por páginas al servidor). Sin filas no se pinta nada: la pantalla
 * ya enseña su estado vacío.
 */
export function DataTablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  noun = DEFAULT_NOUN,
  label = "Paginación",
  maxPerPage,
  disabled,
  className,
}: DataTablePaginationProps) {
  if (total <= 0) return null;
  // «Todos» pide un solo tramo; si el servidor tiene tope, la lista se parte en tramos de ese tamaño.
  const size = maxPerPage ? Math.min(rowsPerPage(pageSize), maxPerPage) : pageSize;
  const info = pageInfo(total, page, size);

  return (
    <nav
      aria-label={label}
      className={cn("mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2", className)}
    >
      <ShowingCount info={info} total={total} noun={noun} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {info.pages > 1 && (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(info.page - 1)}
              disabled={disabled || info.page <= 1}
              aria-label="Página anterior"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              Anterior
            </Button>
            {pageWindow(info.page, info.pages).map((n, i) =>
              n === null ? (
                <span key={`gap${i}`} className="px-1 text-text-3" aria-hidden>
                  …
                </span>
              ) : (
                <Button
                  key={n}
                  variant={n === info.page ? "default" : "ghost"}
                  size="sm"
                  onClick={() => onPageChange(n)}
                  disabled={disabled}
                  aria-label={`Página ${n}`}
                  aria-current={n === info.page ? "page" : undefined}
                  className="min-w-8 tabular-nums"
                >
                  {n}
                </Button>
              )
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(info.page + 1)}
              disabled={disabled || info.page >= info.pages}
              aria-label="Página siguiente"
            >
              Siguiente
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        )}
      </div>
    </nav>
  );
}
