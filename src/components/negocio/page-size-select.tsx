"use client";

import { SearchSelect } from "@/components/ui/search-select";
import { PAGE_SIZES, pageSizeLabel } from "@/lib/salon/cash-shifts";

const OPTIONS = PAGE_SIZES.map((n) => ({ value: String(n), label: pageSizeLabel(n) }));

/** Selector de filas por página (con buscador, como todo desplegable del sistema). */
export function PageSizeSelect({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (size: number) => void;
  disabled?: boolean;
}) {
  return (
    <SearchSelect
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
      options={OPTIONS}
      ariaLabel="Filas por página"
      searchPlaceholder="Buscar…"
      disabled={disabled}
      className="w-40"
    />
  );
}
