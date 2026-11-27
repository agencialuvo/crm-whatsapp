import { describe, expect, it } from "vitest";
import { TEMPLATE_GONE_GRACE_MS, templatesGoneFromMeta } from "@/lib/templates";

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const old = new Date(NOW - TEMPLATE_GONE_GRACE_MS - 1);
const fresh = new Date(NOW - 60_000);

describe("templatesGoneFromMeta (sync: lo que ya no está en Meta)", () => {
  const local = [
    { id: "a", status: "approved", updatedAt: old },
    { id: "b", status: "rejected", updatedAt: old },
    { id: "c", status: "pending", updatedAt: fresh },
    { id: "d", status: "draft", updatedAt: old },
    { id: "e", status: "approved", updatedAt: old },
  ];

  it("ausente en Meta, vieja y no borrador → se da por borrada", () => {
    expect(templatesGoneFromMeta(local, new Set(["a"]), true, NOW)).toEqual(["b", "e"]);
  });

  it("la recién creada o editada no se toca aunque aún no salga en el listado", () => {
    expect(templatesGoneFromMeta(local, new Set(), true, NOW)).not.toContain("c");
  });

  it("un borrador nunca se mandó a Meta: no cuenta", () => {
    expect(templatesGoneFromMeta(local, new Set(), true, NOW)).not.toContain("d");
  });

  it("con la lista incompleta (tope de páginas) no se afirma nada", () => {
    expect(templatesGoneFromMeta(local, new Set(), false, NOW)).toEqual([]);
  });

  it("justo en el borde de la gracia ya cuenta", () => {
    const edge = [{ id: "x", status: "approved", updatedAt: new Date(NOW - TEMPLATE_GONE_GRACE_MS) }];
    expect(templatesGoneFromMeta(edge, new Set(), true, NOW)).toEqual(["x"]);
  });
});
