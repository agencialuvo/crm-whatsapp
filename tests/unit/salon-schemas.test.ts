import { describe, expect, it } from "vitest";
import {
  assignStaffSchema,
  saleEditSchema,
  comboInputSchema,
  comboPatchSchema,
  commissionOverridesSchema,
  normalizeKeyword,
  saleInputSchema,
  saleItemsOf,
  scheduleInputSchema,
  serviceInputSchema,
  servicePatchSchema,
  staffInputSchema,
  staffPatchSchema,
  newBoardBookingSchema,
} from "@/lib/salon/schemas";

/**
 * Módulo SALON — los contratos de entrada. Los usan la API y los formularios:
 * si estos esquemas dejan pasar algo, llega a la base.
 */

describe("normalizeKeyword", () => {
  it("MAYÚSCULAS, sin acentos, espacios como guion bajo", () => {
    expect(normalizeKeyword("combo fresh")).toBe("COMBO_FRESH");
    expect(normalizeKeyword("  Promoción  Navidad ")).toBe("PROMOCION_NAVIDAD");
    expect(normalizeKeyword("combo-fresh!!")).toBe("COMBO-FRESH");
  });

  it("dos escrituras del mismo texto dan la MISMA clave (la que protege el índice único)", () => {
    expect(normalizeKeyword("Combo Fresh")).toBe(normalizeKeyword("COMBO_FRESH"));
  });
});

describe("servicios", () => {
  const ok = { name: "Corte clásico", priceCents: 2500, durationMinutes: 30 };

  it("acepta un servicio válido", () => {
    expect(serviceInputSchema.safeParse(ok).success).toBe(true);
  });

  it.each([
    ["nombre corto", { ...ok, name: "A" }],
    ["precio negativo", { ...ok, priceCents: -1 }],
    ["precio con decimales (no son centavos enteros)", { ...ok, priceCents: 25.5 }],
    ["precio absurdo", { ...ok, priceCents: 999_999_999 }],
    ["duración de 0", { ...ok, durationMinutes: 0 }],
    ["duración de más de 10 h", { ...ok, durationMinutes: 601 }],
    ["comisión de 101 %", { ...ok, defaultCommissionPercentage: 101 }],
    ["precio NaN (campo vacío)", { ...ok, priceCents: Number.NaN }],
  ])("rechaza %s", (_label, input) => {
    expect(serviceInputSchema.safeParse(input).success).toBe(false);
  });

  it("recorta el nombre y convierte la descripción vacía en null", () => {
    const r = serviceInputSchema.parse({ ...ok, name: "  Barba  ", description: "   " });
    expect(r.name).toBe("Barba");
    expect(r.description).toBeNull();
  });

  it("PATCH: lo ausente NO se toca (undefined) y lo vacío SE BORRA (null)", () => {
    expect(servicePatchSchema.parse({ priceCents: 3000 })).toEqual({ priceCents: 3000 });
    expect(servicePatchSchema.parse({ description: "" }).description).toBeNull();
    expect("description" in servicePatchSchema.parse({ priceCents: 3000 })).toBe(false);
  });

  it("PATCH: un cuerpo vacío es un error, no un éxito silencioso", () => {
    expect(servicePatchSchema.safeParse({}).success).toBe(false);
  });
});

describe("combos", () => {
  const ok = {
    name: "Combo Fresh",
    description: "Corte, mascarilla y masaje",
    priceCents: 4500,
    durationMinutes: 60,
  };

  it("normaliza la palabra clave al guardar", () => {
    expect(comboInputSchema.parse({ ...ok, keywordTrigger: "combo fresh" }).keywordTrigger).toBe(
      "COMBO_FRESH"
    );
  });

  it("la palabra clave es opcional y vacía equivale a ninguna", () => {
    expect(comboInputSchema.parse(ok).keywordTrigger).toBeUndefined();
    expect(comboInputSchema.parse({ ...ok, keywordTrigger: "" }).keywordTrigger).toBeNull();
    expect(comboInputSchema.parse({ ...ok, keywordTrigger: null }).keywordTrigger).toBeNull();
  });

  it("rechaza una palabra clave de menos de 3 caracteres o solo símbolos", () => {
    expect(comboInputSchema.safeParse({ ...ok, keywordTrigger: "ab" }).success).toBe(false);
    // "!!!" se normaliza a vacío ⇒ null (sin clave), que es válido: no se guarda basura.
    expect(comboInputSchema.parse({ ...ok, keywordTrigger: "!!!" }).keywordTrigger).toBeNull();
    expect(comboInputSchema.safeParse({ ...ok, keywordTrigger: "x".repeat(41) }).success).toBe(false);
  });

  it("exige contar qué incluye", () => {
    expect(comboInputSchema.safeParse({ ...ok, description: "" }).success).toBe(false);
  });

  it("PATCH parcial", () => {
    expect(comboPatchSchema.parse({ active: false })).toEqual({ active: false });
    expect(comboPatchSchema.safeParse({}).success).toBe(false);
  });
});

describe("equipo", () => {
  it("alta mínima: solo el nombre", () => {
    expect(staffInputSchema.safeParse({ name: "Carlos" }).success).toBe(true);
  });

  it("celular: exactamente 9 dígitos (con o sin +51), se guarda normalizado; lo demás se rechaza", () => {
    expect(staffInputSchema.parse({ name: "Ana", phone: "+51 987 654 321" }).phone).toBe("+51987654321");
    expect(staffInputSchema.parse({ name: "Ana", phone: "987654321" }).phone).toBe("+51987654321");
    // Ya no vale un fijo con paréntesis ni un número corto, largo o con letras.
    expect(staffInputSchema.safeParse({ name: "Ana", phone: "(01) 555-1234" }).success).toBe(false);
    expect(staffInputSchema.safeParse({ name: "Ana", phone: "llámame" }).success).toBe(false);
    expect(staffInputSchema.safeParse({ name: "Ana", phone: "98765432" }).success).toBe(false);
    expect(staffInputSchema.parse({ name: "Ana", phone: "" }).phone).toBeNull();
  });

  it("comisión global: entera, 0-100 o null (sin porcentaje propio)", () => {
    expect(staffInputSchema.parse({ name: "Ana", globalCommissionPercentage: null }).globalCommissionPercentage).toBeNull();
    expect(staffInputSchema.safeParse({ name: "Ana", globalCommissionPercentage: 101 }).success).toBe(false);
    expect(staffInputSchema.safeParse({ name: "Ana", globalCommissionPercentage: 12.5 }).success).toBe(false);
  });

  it("PATCH vacío es un error", () => {
    expect(staffPatchSchema.safeParse({}).success).toBe(false);
    expect(staffPatchSchema.parse({ active: false })).toEqual({ active: false });
  });
});

describe("horario", () => {
  const day = (dayOfWeek: number, o: Partial<{ isOff: boolean; startTime: string; endTime: string }> = {}) => ({
    dayOfWeek,
    isOff: false,
    startTime: "10:00",
    endTime: "20:00",
    ...o,
  });

  it("acepta días libres y de horario propio", () => {
    expect(scheduleInputSchema.safeParse({ days: [day(1), day(0, { isOff: true })] }).success).toBe(true);
    expect(scheduleInputSchema.safeParse({ days: [] }).success).toBe(true);
  });

  it("la salida debe ser después de la entrada (salvo en un día libre)", () => {
    expect(scheduleInputSchema.safeParse({ days: [day(2, { startTime: "18:00", endTime: "09:00" })] }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ days: [day(2, { startTime: "10:00", endTime: "10:00" })] }).success).toBe(false);
    expect(
      scheduleInputSchema.safeParse({ days: [day(2, { isOff: true, startTime: "18:00", endTime: "09:00" })] }).success
    ).toBe(true);
  });

  it("rechaza horas mal escritas, días fuera de 0-6 y días repetidos", () => {
    expect(scheduleInputSchema.safeParse({ days: [day(1, { startTime: "9:00" })] }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ days: [day(1, { endTime: "24:30" })] }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ days: [day(7)] }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ days: [day(1), day(1)] }).success).toBe(false);
  });
});

describe("comisiones por servicio", () => {
  it("acepta pactos 0-100 y rechaza servicios repetidos", () => {
    expect(
      commissionOverridesSchema.safeParse({ overrides: [{ serviceId: "srv_a", percentage: 60 }] }).success
    ).toBe(true);
    expect(
      commissionOverridesSchema.safeParse({
        overrides: [
          { serviceId: "srv_a", percentage: 60 },
          { serviceId: "srv_a", percentage: 40 },
        ],
      }).success
    ).toBe(false);
    expect(
      commissionOverridesSchema.safeParse({ overrides: [{ serviceId: "srv_a", percentage: 101 }] }).success
    ).toBe(false);
  });
});

describe("venta", () => {
  const ok = { staffId: "stf_1", serviceId: "srv_1", amountCents: 2500, paymentMethod: "yape_plin" } as const;

  it("acepta un servicio o un combo, nunca ninguno ni los dos", () => {
    expect(saleInputSchema.safeParse(ok).success).toBe(true);
    expect(
      saleInputSchema.safeParse({ ...ok, serviceId: undefined, comboId: "cmb_1" }).success
    ).toBe(true);
    expect(saleInputSchema.safeParse({ ...ok, serviceId: undefined }).success).toBe(false);
    expect(saleInputSchema.safeParse({ ...ok, comboId: "cmb_1" }).success).toBe(false);
  });

  it("el carrito: uno o varios ítems; «Otro» lleva su precio; no se mezcla con un ítem suelto", () => {
    const base = { staffId: "stf_1", amountCents: 6000, paymentMethod: "efectivo" } as const;
    const carrito = [{ serviceId: "srv_1" }, { comboId: "cmb_1" }, { other: true, amountCents: 1500, note: "Peinado para evento" }];
    expect(saleInputSchema.safeParse({ ...base, items: carrito }).success).toBe(true);
    expect(saleInputSchema.safeParse({ ...base, items: [] }).success).toBe(false);
    expect(saleInputSchema.safeParse({ ...base, items: [{ other: true }] }).success).toBe(false);
    expect(saleInputSchema.safeParse({ ...base, items: [{}] }).success).toBe(false);
    expect(saleInputSchema.safeParse({ ...base, items: [{ serviceId: "srv_1", comboId: "cmb_1" }] }).success).toBe(false);
    expect(saleInputSchema.safeParse({ ...base, items: carrito, serviceId: "srv_2" }).success).toBe(false);
    expect(saleInputSchema.safeParse({ ...base, items: Array(21).fill({ serviceId: "srv_1" }) }).success).toBe(false);
    const r = saleInputSchema.safeParse({ ...base, serviceId: "srv_1" });
    expect(r.success && saleItemsOf(r.data)).toEqual([
      { serviceId: "srv_1", comboId: null, other: false, amountCents: undefined, note: undefined },
    ]);
  });

  it("«Otro» exige el detalle de qué fue (en el carrito y en la forma de un solo ítem)", () => {
    const base = { staffId: "stf_1", amountCents: 6000, paymentMethod: "efectivo" } as const;
    const otro = (note?: string) => ({ ...base, items: [{ other: true, amountCents: 6000, note }] });
    expect(saleInputSchema.safeParse(otro("Peinado para evento")).success).toBe(true);
    for (const note of [undefined, "", "   "]) {
      expect(saleInputSchema.safeParse(otro(note)).success, String(note)).toBe(false);
    }
    expect(saleInputSchema.safeParse(otro("x".repeat(81))).success).toBe(false);
    expect(saleInputSchema.safeParse({ ...base, other: true }).success).toBe(false);
    expect(saleInputSchema.safeParse({ ...base, other: true, otherNote: "Tinte" }).success).toBe(true);
    // Un servicio del catálogo no necesita detalle.
    expect(saleInputSchema.safeParse({ ...base, items: [{ serviceId: "srv_1" }] }).success).toBe(true);
  });

  it("editar venta: ítems, profesional y monto; «Otro» con detalle; sin cliente ni fecha", () => {
    const ok = { items: [{ serviceId: "srv_1" }], staffId: "stf_1", amountCents: 3000 };
    expect(saleEditSchema.safeParse(ok).success).toBe(true);
    expect(saleEditSchema.safeParse({ ...ok, items: [] }).success).toBe(false);
    expect(saleEditSchema.safeParse({ ...ok, staffId: "" }).success).toBe(false);
    expect(saleEditSchema.safeParse({ ...ok, amountCents: undefined }).success).toBe(false);
    expect(saleEditSchema.safeParse({ ...ok, items: [{ other: true, amountCents: 500 }] }).success).toBe(false);
    expect(
      saleEditSchema.safeParse({ ...ok, items: [{ other: true, amountCents: 500, note: "Tinte" }] }).success,
    ).toBe(true);
    const r = saleEditSchema.safeParse({ ...ok, contactId: "ct_x", soldOn: "2026-01-01" });
    expect(r.success && "contactId" in r.data).toBe(false);
  });

  it("nombre del cliente de Caja: solo letras y espacios (vacío = mostrador)", () => {
    const base = { staffId: "stf_1", serviceId: "srv_1", amountCents: 3000, paymentMethod: "efectivo" } as const;
    for (const customerName of ["María Pérez", "  Ñandú   Núñez ", "", null, undefined]) {
      expect(saleInputSchema.safeParse({ ...base, customerName }).success, String(customerName)).toBe(true);
    }
    for (const customerName of ["Ana2", "Ana-Luz", "J@vier", "123"]) {
      expect(saleInputSchema.safeParse({ ...base, customerName }).success, customerName).toBe(false);
    }
  });

  it("celular y cumpleaños: dígitos con país; día y mes juntos y reales", () => {
    const base = { ...ok, customerName: "María" };
    expect(saleInputSchema.safeParse({ ...base, customerPhone: "51987654321" }).success).toBe(true);
    expect(saleInputSchema.safeParse({ ...base, customerPhone: "98765" }).success).toBe(false);
    // Con celular hace falta el nombre (salvo que ya sea un contacto).
    expect(
      saleInputSchema.safeParse({ ...ok, customerName: "", customerPhone: "51987654321" }).success
    ).toBe(false);
    expect(saleInputSchema.safeParse({ ...base, birthdayDay: 29, birthdayMonth: 2 }).success).toBe(true);
    expect(saleInputSchema.safeParse({ ...base, birthdayDay: 31, birthdayMonth: 4 }).success).toBe(false);
    expect(saleInputSchema.safeParse({ ...base, birthdayDay: 10 }).success).toBe(false);
    expect(saleInputSchema.safeParse({ ...base, birthdayMonth: 13, birthdayDay: 1 }).success).toBe(false);
  });

  it("método de pago: solo los cuatro conocidos (Yape y Plin son uno)", () => {
    for (const m of ["efectivo", "yape_plin", "tarjeta", "otro"]) {
      expect(saleInputSchema.safeParse({ ...ok, paymentMethod: m }).success).toBe(true);
    }
    for (const m of ["yape", "plin"]) {
      expect(saleInputSchema.safeParse({ ...ok, paymentMethod: m }).success).toBe(false);
    }
    expect(saleInputSchema.safeParse({ ...ok, paymentMethod: "bitcoin" }).success).toBe(false);
    expect(saleInputSchema.safeParse({ ...ok, paymentMethod: undefined }).success).toBe(false);
  });

  it("el monto es no negativo y en centavos enteros", () => {
    expect(saleInputSchema.safeParse({ ...ok, amountCents: -1 }).success).toBe(false);
    expect(saleInputSchema.safeParse({ ...ok, amountCents: 10.5 }).success).toBe(false);
    expect(saleInputSchema.safeParse({ ...ok, amountCents: 0 }).success).toBe(true);
  });

  it("la comisión puntual debe estar en 0-100", () => {
    expect(saleInputSchema.safeParse({ ...ok, customCommissionPercentage: 70 }).success).toBe(true);
    expect(saleInputSchema.safeParse({ ...ok, customCommissionPercentage: 120 }).success).toBe(false);
  });
});

describe("asignar profesional", () => {
  it("acepta un id o null (quitar)", () => {
    expect(assignStaffSchema.safeParse({ staffId: "stf_1" }).success).toBe(true);
    expect(assignStaffSchema.safeParse({ staffId: null }).success).toBe(true);
    expect(assignStaffSchema.safeParse({}).success).toBe(false);
    expect(assignStaffSchema.safeParse({ staffId: "" }).success).toBe(false);
  });
});

describe("newBoardBookingSchema — agendar cita desde la agenda por sillas", () => {
  const ok = { contactId: "ct_1", serviceId: "srv_1", startUtc: "2026-10-19T15:00:00.000Z" };

  it("acepta cliente + hora + servicio, con profesional opcional", () => {
    expect(newBoardBookingSchema.parse(ok)).toEqual({ ...ok, staffId: null, notes: null });
    expect(newBoardBookingSchema.parse({ ...ok, staffId: "stf_1", notes: " corte y barba " })).toEqual({
      ...ok,
      staffId: "stf_1",
      notes: "corte y barba",
    });
  });

  it("exige cliente y una hora válida", () => {
    expect(newBoardBookingSchema.safeParse({ startUtc: ok.startUtc }).success).toBe(false);
    expect(newBoardBookingSchema.safeParse({ ...ok, contactId: "" }).success).toBe(false);
    expect(newBoardBookingSchema.safeParse({ ...ok, startUtc: "mañana" }).success).toBe(false);
    expect(newBoardBookingSchema.safeParse({ contactId: "ct_1" }).success).toBe(false);
  });

  it("exige el servicio u oferta, uno solo", () => {
    const { serviceId: _s, ...sinItem } = ok;
    void _s;
    expect(newBoardBookingSchema.safeParse(sinItem).success).toBe(false);
    expect(newBoardBookingSchema.safeParse({ ...sinItem, comboId: "cmb_1" }).success).toBe(true);
    expect(newBoardBookingSchema.safeParse({ ...ok, comboId: "cmb_1" }).success).toBe(false);
  });

  it("notas vacías son null y más de 500 caracteres se rechazan", () => {
    expect(newBoardBookingSchema.parse({ ...ok, notes: "   " }).notes).toBeNull();
    expect(newBoardBookingSchema.safeParse({ ...ok, notes: "x".repeat(501) }).success).toBe(false);
  });
});
