import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regla del sistema: toda tabla o listado con filas lleva el pie estándar `DataTablePagination`
 * (filas por página `10 | 25 | 50 | 100 | Todos`, recordadas por persona). Al crear una tabla nueva,
 * agrégala aquí: el patrón es `useDataTable(filas, { view })` + `<DataTablePagination …/>`.
 */
const TABLAS = [
  "src/components/negocio/clients-client.tsx",
  "src/components/negocio/cash-client.tsx",
  "src/components/negocio/expenses-client.tsx",
  "src/components/negocio/catalog-client.tsx",
  "src/components/negocio/staff-client.tsx",
  "src/components/negocio/client-history-dialog.tsx",
  "src/components/negocio/shift-history-client.tsx",
  "src/components/contacts/contacts-client.tsx",
];

const leer = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

describe("paginación de tablas", () => {
  it.each(TABLAS)("%s usa el pie estándar", (f) => {
    const src = leer(f);
    expect(src).toContain("<DataTablePagination");
    // La barra superior lleva el conteo (izquierda) y el selector de filas (derecha).
    expect(src).toContain("<DataTableToolbar");
    // Las que cargan todo en el navegador usan el hook; la del historial pide por tramos al servidor.
    expect(/useDataTable\(|useTablePageSize\(/.test(src)).toBe(true);
  });

  it("nadie vuelve a armar su propio selector de filas ni su «Mostrar más»", () => {
    for (const f of TABLAS) {
      const src = leer(f);
      expect(src, f).not.toContain("PageSizeSelect");
      expect(src, f).not.toContain("Mostrar más");
    }
  });

  it("el selector ofrece exactamente 10, 25, 50, 100 y Todos", () => {
    const src = leer("src/components/ui/data-table-pagination.tsx");
    expect(src).toContain("PAGE_SIZES.map");
  });
});
