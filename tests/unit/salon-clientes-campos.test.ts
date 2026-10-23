import { describe, expect, it } from "vitest";
import { clientCreateSchema, clientInputSchema } from "@/lib/salon/schemas";
import { dateNumeric, formatPeruPhone } from "@/lib/salon/format";
import { formatDay } from "@/components/ui/date-picker";

/** Clientes: nombre solo letras, celular de 9 dígitos y fechas sin hora. */

const base = { name: "María Pérez", phone: "51912345678" };

describe("cliente: nombre solo con letras y espacios", () => {
  it("acepta tildes y ñ, y ordena los espacios", () => {
    const r = clientInputSchema.safeParse({ ...base, name: "  Ñandú   Núñez " });
    expect(r.success && r.data.name).toBe("Ñandú Núñez");
  });

  it("rechaza números y signos", () => {
    for (const name of ["Ana2", "Ana-Luz", "J@vier", "123", ""]) {
      expect(clientInputSchema.safeParse({ ...base, name }).success, name).toBe(false);
    }
  });
});

describe("cliente: celular de Perú, exactamente 9 dígitos", () => {
  it("acepta 51 + 9 dígitos", () => {
    expect(clientInputSchema.safeParse(base).success).toBe(true);
  });

  it("rechaza menos o más dígitos, letras y otros países", () => {
    for (const phone of ["5191234567", "519123456789", "51912345abc", "912345678", "34912345678"]) {
      expect(clientInputSchema.safeParse({ ...base, phone }).success, phone).toBe(false);
    }
  });

  it("el celular es opcional: vacío o ausente se vuelve null", () => {
    expect(clientInputSchema.parse({ ...base, phone: "" }).phone).toBeNull();
    expect(clientInputSchema.parse({ ...base, phone: null }).phone).toBeNull();
    const { phone: _p, ...sinCelular } = base;
    void _p;
    expect(clientInputSchema.parse(sinCelular).phone).toBeNull();
  });
});

describe("cliente: alta con la atención", () => {
  const alta = {
    ...base,
    items: [{ serviceId: "srv_aaaaaaaaaaaaaaaaaaaa" }, { other: true, note: "Peinado", amountCents: 3000 }],
    amountCents: 8000,
    staffId: "stf_aaaaaaaaaaaaaaaaaaaa",
    paymentMethod: "yape_plin" as const,
    soldOn: "2026-10-20",
    birthdayDay: 5,
    birthdayMonth: 3,
  };

  it("lleva fecha de atención (solo día), servicio, profesional y método de pago", () => {
    expect(clientCreateSchema.safeParse(alta).success).toBe(true);
  });

  it("el alta exige al menos un ítem, el monto y que «Otro» lleve su detalle", () => {
    expect(clientCreateSchema.safeParse({ ...alta, items: [] }).success).toBe(false);
    expect(clientCreateSchema.safeParse({ ...alta, items: undefined }).success).toBe(false);
    expect(clientCreateSchema.safeParse({ ...alta, amountCents: undefined }).success).toBe(false);
    expect(
      clientCreateSchema.safeParse({ ...alta, items: [{ other: true, amountCents: 3000 }] }).success,
    ).toBe(false);
    expect(clientCreateSchema.safeParse({ ...alta, customCommissionPercentage: 30 }).success).toBe(true);
    expect(clientCreateSchema.safeParse({ ...alta, customCommissionPercentage: 130 }).success).toBe(false);
  });

  it("el alta no exige nombre ni celular (sin ninguno, es una venta de mostrador)", () => {
    const { name: _n, phone: _p, ...sinDatos } = alta;
    void _n;
    void _p;
    const r = clientCreateSchema.parse(sinDatos);
    expect(r.name).toBeNull();
    expect(r.phone).toBeNull();
    expect(clientCreateSchema.parse({ ...sinDatos, name: "  ", phone: "" }).name).toBeNull();
    // Si se escriben, siguen validándose.
    expect(clientCreateSchema.safeParse({ ...sinDatos, name: "A1" }).success).toBe(false);
    expect(clientCreateSchema.safeParse({ ...sinDatos, phone: "5191" }).success).toBe(false);
  });

  it("la fecha de atención no admite hora", () => {
    expect(clientCreateSchema.safeParse({ ...alta, soldOn: "2026-10-20T10:30" }).success).toBe(false);
  });

  it("el cumpleaños es solo día y mes: sin año", () => {
    const r = clientCreateSchema.safeParse({ ...alta, birthdayYear: 1990 });
    expect(r.success && "birthdayYear" in r.data).toBe(false);
  });
});

describe("formato visual", () => {
  it("el celular se ve +51 912 345 678", () => {
    expect(formatPeruPhone("51912345678")).toBe("+51 912 345 678");
    expect(formatPeruPhone(null)).toBe("—");
    expect(formatPeruPhone("34600111222")).toBe("+34600111222");
  });

  it("las fechas se ven DD/MM/AAAA, en la zona del negocio y sin hora", () => {
    expect(formatDay("2026-10-20")).toBe("20/10/2026");
    expect(formatDay("")).toBe("");
    // 03:00 UTC del 21 aún es el 20 en Lima (UTC-5).
    expect(dateNumeric("2026-10-21T03:00:00.000Z", "America/Lima")).toBe("20/10/2026");
  });
});
