import { describe, expect, it } from "vitest";
import { comboInputSchema, serviceInputSchema } from "@/lib/salon/schemas";
import {
  itemIsRestricted,
  staffAfterItemChange,
  staffForItem,
} from "@/lib/salon/staff-for-item";
import type { SaleOptionsDto } from "@/lib/salon/types";
import { staffIdsToSend, staffPreview } from "@/components/negocio/staff-select";

/**
 * Servicios y ofertas: la imagen de la biblioteca de Medios y los profesionales
 * que lo dan (sin detallar = todo el equipo).
 */

const MEDIA = "med_abcdefghij0123456789";
const A = "stf_aaaaaaaaaaaaaaaaaaaa";
const B = "stf_bbbbbbbbbbbbbbbbbbbb";
const C = "stf_cccccccccccccccccccc";

const base = { name: "Corte clásico", priceCents: 2500, durationMinutes: 30 };
const baseCombo = { ...base, description: "Corte y mascarilla" };

describe("contrato: imagen y profesionales", () => {
  it("son opcionales: un servicio sin ellos sigue siendo válido", () => {
    const r = serviceInputSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.imageMediaId).toBeUndefined();
      expect(r.data.staffIds).toBeUndefined();
    }
  });

  it("acepta el id de un medio, null para quitarla y [] para «todos»", () => {
    expect(serviceInputSchema.safeParse({ ...base, imageMediaId: MEDIA }).success).toBe(true);
    expect(serviceInputSchema.safeParse({ ...base, imageMediaId: null }).success).toBe(true);
    expect(serviceInputSchema.safeParse({ ...base, staffIds: [] }).success).toBe(true);
    expect(serviceInputSchema.safeParse({ ...base, staffIds: [A, B] }).success).toBe(true);
  });

  it("rechaza lo que no es un id de medio (no hay URL a mano)", () => {
    for (const imageMediaId of ["https://sitio.com/foto.jpg", "foto.jpg", "med_corto", "../etc"]) {
      expect(serviceInputSchema.safeParse({ ...base, imageMediaId }).success, imageMediaId).toBe(false);
    }
  });

  it("rechaza profesionales con forma inválida o repetidos", () => {
    expect(serviceInputSchema.safeParse({ ...base, staffIds: ["abc"] }).success).toBe(false);
    expect(serviceInputSchema.safeParse({ ...base, staffIds: [A, A] }).success).toBe(false);
  });

  it("las ofertas llevan exactamente lo mismo", () => {
    expect(comboInputSchema.safeParse({ ...baseCombo, imageMediaId: MEDIA, staffIds: [A] }).success).toBe(true);
    expect(comboInputSchema.safeParse({ ...baseCombo, imageMediaId: "http://x.com/a.jpg" }).success).toBe(false);
    expect(comboInputSchema.safeParse({ ...baseCombo, staffIds: [A, A] }).success).toBe(false);
  });
});

describe("la casilla «Detallar profesionales»", () => {
  it("apagada: se manda [] y el sistema asume que lo dan todos", () => {
    expect(staffIdsToSend(false, [])).toEqual({ staffIds: [] });
    // Aunque haya algo marcado de antes, apagada manda «todos».
    expect(staffIdsToSend(false, [A, B])).toEqual({ staffIds: [] });
  });

  it("encendida: se mandan los elegidos", () => {
    expect(staffIdsToSend(true, [A, B])).toEqual({ staffIds: [A, B] });
  });

  it("encendida sin elegir a nadie es un error (nadie podría darlo)", () => {
    const r = staffIdsToSend(true, []);
    expect(r.error).toMatch(/al menos un profesional/);
  });
});

describe("previsualización: quién da el servicio u oferta", () => {
  const D = "stf_dddddddddddddddddddd";
  const S1 = "srv_aaaaaaaaaaaaaaaaaaaa";
  const servicio = (staffIds: string[], id = S1) => ({ kind: "service" as const, id, staffIds });
  const oferta = (staffIds: string[]) => ({ kind: "combo" as const, id: "cmb_aaaaaaaaaaaaaaaaaaaa", staffIds });
  const team = () => [
    { id: A, name: "Cheo", active: true },
    { id: B, name: "Alexander", active: true },
    { id: C, name: "Mari", active: true },
    { id: D, name: "Retirado", active: false },
  ];

  it("sin nadie detallado: «Todos los profesionales», sin enumerar a nadie", () => {
    const texto = staffPreview(servicio([]), team());
    expect(texto).toBe("Todos los profesionales");
    for (const m of team()) expect(texto).not.toContain(m.name);
  });

  it("sin detallar sigue diciendo lo mismo aunque no haya equipo cargado", () => {
    expect(staffPreview(servicio([]), [])).toBe("Todos los profesionales");
  });

  it("con uno detallado: «Profesional: » y su nombre (singular)", () => {
    expect(staffPreview(servicio([A]), team())).toBe("Profesional: Cheo");
  });

  it("con varios detallados: «Profesionales: » y la lista (plural), en el orden del equipo", () => {
    expect(staffPreview(servicio([C, A]), team())).toBe("Profesionales: Cheo, Mari");
    expect(staffPreview(servicio([A, B, C]), team())).toBe("Profesionales: Cheo, Alexander, Mari");
  });

  it("un detallado que ya está inactivo se sigue nombrando", () => {
    expect(staffPreview(servicio([D]), team())).toBe("Profesional: Retirado");
  });

  it("si los nombres no se pueden resolver, no inventa ninguno", () => {
    expect(staffPreview(servicio([A]), [])).toBe("Profesional: —");
  });

  it("las ofertas siguen la misma regla", () => {
    expect(staffPreview(oferta([]), team())).toBe("Todos los profesionales");
    expect(staffPreview(oferta([B]), team())).toBe("Profesional: Alexander");
    expect(staffPreview(oferta([A, B]), team())).toBe("Profesionales: Cheo, Alexander");
  });
});

describe("caja: quién puede cobrar qué", () => {
  const options: SaleOptionsDto = {
    services: [
      { id: "s1", name: "Corte", priceCents: 2500, durationMinutes: 30, staffIds: [A, B] },
      { id: "s2", name: "Barba", priceCents: 1500, durationMinutes: 30, staffIds: [] },
      { id: "s3", name: "Tinte", priceCents: 9000, durationMinutes: 30, staffIds: [C] },
    ],
    combos: [{ id: "c1", name: "Oferta Fresh", priceCents: 4000, durationMinutes: 30, staffIds: [B] }],
    staff: [
      { id: A, name: "Ana" },
      { id: B, name: "Beto" },
      { id: C, name: "Carla" },
    ],
  };

  it("un servicio con lista restringe a esos profesionales", () => {
    expect(itemIsRestricted(options, "service:s1")).toBe(true);
    expect(staffForItem(options, "service:s1").map((m) => m.id)).toEqual([A, B]);
  });

  it("sin lista, o con «Otro», o sin nada elegido, los da todo el equipo", () => {
    expect(staffForItem(options, "service:s2")).toHaveLength(3);
    expect(itemIsRestricted(options, "service:s2")).toBe(false);
    expect(staffForItem(options, "other")).toHaveLength(3);
    expect(staffForItem(options, "")).toHaveLength(3);
    expect(staffForItem(null, "service:s1")).toEqual([]);
  });

  it("las ofertas funcionan igual que los servicios", () => {
    expect(staffForItem(options, "combo:c1").map((m) => m.id)).toEqual([B]);
  });

  it("al cambiar de ítem se conserva a quien sigue valiendo", () => {
    expect(staffAfterItemChange(options, "service:s1", A)).toBe(A);
    expect(staffAfterItemChange(options, "service:s2", C)).toBe(C);
  });

  it("si quien estaba elegido no lo da, se pone el único que queda o se vacía", () => {
    // Tinte solo lo da Carla: Ana deja su lugar a Carla.
    expect(staffAfterItemChange(options, "service:s3", A)).toBe(C);
    // Corte lo dan dos: no se adivina, se vacía.
    expect(staffAfterItemChange(options, "service:s1", C)).toBe("");
  });

  it("un ítem sin lista no elige a nadie por su cuenta", () => {
    expect(staffAfterItemChange(options, "service:s2", "")).toBe("");
  });
});
