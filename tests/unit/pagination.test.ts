import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  PAGE_SIZE_ALL,
  isPageSize,
  pageInfo,
  pageSizeLabel,
  pageWindow,
  rowsPerPage,
} from "@/lib/pagination";
import { setTablePageSizeInputSchema } from "@/lib/salon/cash-shifts";

describe("regla de paginación de las tablas", () => {
  it("las filas por página son 10 | 25 | 50 | 100 | Todos", () => {
    expect([...PAGE_SIZES]).toEqual([10, 25, 50, 100, 0]);
    expect(PAGE_SIZES.map(pageSizeLabel)).toEqual([
      "10 por página",
      "25 por página",
      "50 por página",
      "100 por página",
      "Todos",
    ]);
    expect(isPageSize(DEFAULT_PAGE_SIZE)).toBe(true);
  });

  it("solo esos valores son válidos (también al guardarlos por persona)", () => {
    for (const n of [10, 25, 50, 100, PAGE_SIZE_ALL]) expect(isPageSize(n)).toBe(true);
    for (const n of [-1, 5, 20, 101, 1.5, NaN, "25", null, undefined]) expect(isPageSize(n)).toBe(false);
    expect(setTablePageSizeInputSchema.safeParse({ view: "gastos", pageSize: 0 }).success).toBe(true);
    expect(setTablePageSizeInputSchema.safeParse({ view: "gastos", pageSize: 7 }).success).toBe(false);
  });

  it("«Todos» (0) no tiene tope", () => {
    expect(rowsPerPage(PAGE_SIZE_ALL)).toBe(Number.MAX_SAFE_INTEGER);
    expect(rowsPerPage(25)).toBe(25);
  });
});

describe("pageInfo — dónde cae cada página", () => {
  it("de 10 en 10: primera, intermedia y última (incompleta)", () => {
    expect(pageInfo(42, 1, 10)).toEqual({ page: 1, pages: 5, from: 1, to: 10, offset: 0, limit: 10 });
    expect(pageInfo(42, 3, 10)).toMatchObject({ page: 3, from: 21, to: 30, offset: 20 });
    expect(pageInfo(42, 5, 10)).toMatchObject({ page: 5, from: 41, to: 42, offset: 40 });
  });

  it("«Todos» muestra todo en una sola página", () => {
    const i = pageInfo(1234, 1, PAGE_SIZE_ALL);
    expect(i).toMatchObject({ page: 1, pages: 1, from: 1, to: 1234, offset: 0 });
    expect(pageInfo(1234, 9, PAGE_SIZE_ALL).page).toBe(1);
  });

  it("sin filas no hay «Mostrando 1 a 0»", () => {
    expect(pageInfo(0, 1, 25)).toMatchObject({ page: 1, pages: 1, from: 0, to: 0 });
  });

  it("acota una página que ya no existe (la lista se encogió) o inválida", () => {
    expect(pageInfo(12, 9, 10).page).toBe(2);
    expect(pageInfo(12, 0, 10).page).toBe(1);
    expect(pageInfo(12, -3, 10).page).toBe(1);
    expect(pageInfo(12, NaN, 10).page).toBe(1);
    expect(pageInfo(-5, 1, 10)).toMatchObject({ pages: 1, from: 0, to: 0 });
  });

  it("un total exacto no crea una página vacía", () => {
    expect(pageInfo(50, 1, 25).pages).toBe(2);
    expect(pageInfo(50, 2, 25)).toMatchObject({ from: 26, to: 50 });
  });

  it("rebanar con offset/limit devuelve la página sin perder ni repetir filas", () => {
    const all = Array.from({ length: 23 }, (_, i) => i);
    const seen: number[] = [];
    const { pages } = pageInfo(all.length, 1, 10);
    for (let p = 1; p <= pages; p++) {
      const { offset, limit } = pageInfo(all.length, p, 10);
      seen.push(...all.slice(offset, offset + Math.min(limit, all.length)));
    }
    expect(seen).toEqual(all);
    const everything = pageInfo(all.length, 1, PAGE_SIZE_ALL);
    expect(all.slice(everything.offset, everything.offset + Math.min(everything.limit, all.length))).toEqual(all);
  });
});

describe("pageWindow", () => {
  it("pocas páginas: todas, sin huecos", () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
  });

  it("muchas: primera, vecinas y última con «…» entre los saltos", () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, null, 20]);
    expect(pageWindow(10, 20)).toEqual([1, null, 9, 10, 11, null, 20]);
    expect(pageWindow(20, 20)).toEqual([1, null, 19, 20]);
  });
});
