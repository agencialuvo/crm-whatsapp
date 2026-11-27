import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  birthdayRowState,
  buildBirthdayCampaign,
  computeBirthdayKpis,
  computeFlowBreakdown,
  computeRescueSummary,
  countByFilter,
  filterBirthdays,
  matchesBirthdayFilter,
  rateOf,
  sendOutcome,
  type BirthdayContactRow,
  type BirthdayFacts,
} from "@/lib/salon/birthday-campaign";
import type { SalonDashboardDto } from "@/lib/salon/types";

/**
 * Cumpleaños del mes en el Panel (Pasos 1 y 2): estado por cliente, KPIs (contactados, agendados, aprovecharon),
 * desglose por automatización, filtros rápidos y búsqueda.
 */

const facts = (over: Partial<BirthdayFacts> = {}): BirthdayFacts => ({
  sends: [],
  manual: false,
  booked: false,
  attended: false,
  sales: 0,
  salesCents: 0,
  ...over,
});

describe("qué pasos son envíos", () => {
  it("los mismos que el motor registra al enviar: `send_whatsapp` (texto o plantilla) y `send_media`", async () => {
    const { BIRTHDAY_SEND_STEP_TYPES } = await import("@/lib/salon/birthday-campaign");
    expect([...BIRTHDAY_SEND_STEP_TYPES]).toEqual(["send_whatsapp", "send_media"]);
    const { readFileSync } = await import("node:fs");
    const engine = readFileSync("src/server/automation/engine.ts", "utf8");
    // El registro guarda `step.stepType` en la foto del paso: de ahí lee el Panel.
    expect(engine).toContain("stepType: step.stepType");
  });
});

describe("sendOutcome — qué cuenta como entrega", () => {
  it("éxito del paso sin rebote → entregado; con el mensaje `failed` → fallido", () => {
    expect(sendOutcome({ logStatus: "success", messageStatus: "delivered" })).toBe("delivered");
    expect(sendOutcome({ logStatus: "success", messageStatus: "read" })).toBe("delivered");
    expect(sendOutcome({ logStatus: "success", messageStatus: null })).toBe("delivered");
    expect(sendOutcome({ logStatus: "success", messageStatus: "failed" })).toBe("failed");
  });
  it("fallo del paso o baja → fallido; tope de envíos (postergación) → no dice nada", () => {
    expect(sendOutcome({ logStatus: "failed", messageStatus: null })).toBe("failed");
    expect(sendOutcome({ logStatus: "skipped_opt_out", messageStatus: null })).toBe("failed");
    expect(sendOutcome({ logStatus: "skipped_rate_limit", messageStatus: null })).toBeNull();
  });
});

describe("birthdayRowState — el estado más avanzado gana", () => {
  it("sin nada → sin enviar", () => {
    expect(birthdayRowState(facts())).toMatchObject({ status: "sin_enviar", contactedBy: null, converted: false });
  });
  it("intento automático que no llegó → fallido; si además lo saludaron a mano → saludado (manual)", () => {
    const failed = facts({ sends: [{ flowId: "aut_1", delivered: false }] });
    expect(birthdayRowState(failed)).toMatchObject({ status: "fallido", sendFailed: true, contactedBy: null });
    expect(birthdayRowState({ ...failed, manual: true })).toMatchObject({ status: "enviado", contactedBy: "manual", sendFailed: true });
  });
  it("entregado por automatización → saludado (auto); con saludo manual también → both", () => {
    const sent = facts({ sends: [{ flowId: "aut_1", delivered: true }] });
    expect(birthdayRowState(sent)).toMatchObject({ status: "enviado", contactedBy: "auto", flowIds: ["aut_1"] });
    expect(birthdayRowState({ ...sent, manual: true }).contactedBy).toBe("both");
  });
  it("cita reservada en la ventana → agendado", () => {
    expect(birthdayRowState(facts({ booked: true }))).toMatchObject({ status: "agendado", booked: true, converted: false });
  });
  it("aprovechó = cita realizada O venta en Caja (aunque no lo hayan contactado)", () => {
    expect(birthdayRowState(facts({ attended: true }))).toMatchObject({ status: "aprovecho", booked: true, converted: true });
    expect(birthdayRowState(facts({ sales: 2, salesCents: 9000 }))).toMatchObject({
      status: "aprovecho",
      converted: true,
      windowRevenueCents: 9000,
      contactedBy: null,
    });
  });
});

describe("computeBirthdayKpis", () => {
  const rows = [
    birthdayRowState(facts()), // sin enviar
    birthdayRowState(facts({ sends: [{ flowId: "a", delivered: false }] })), // fallido
    birthdayRowState(facts({ sends: [{ flowId: "a", delivered: true }] })), // saludado auto
    birthdayRowState(facts({ manual: true, booked: true })), // manual + agendado
    birthdayRowState(facts({ sends: [{ flowId: "a", delivered: true }], attended: true, sales: 1, salesCents: 5000 })), // aprovechó contactado
    birthdayRowState(facts({ sales: 1, salesCents: 3000 })), // aprovechó sin contacto
  ];
  const k = computeBirthdayKpis(rows);

  it("cuenta cumpleañeros, contactados (auto/manual), sin enviar y fallidos", () => {
    expect(k).toMatchObject({ total: 6, contacted: 3, contactedAuto: 2, contactedManual: 1, notSent: 1, failed: 1 });
  });
  it("agendados incluye a quien ya se atendió; aprovecharon incluye a quien vino sin saludo", () => {
    expect(k.booked).toBe(2);
    expect(k.converted).toBe(2);
    expect(k.convertedContacted).toBe(1);
  });
  it("% sobre CONTACTADOS y lo cobrado a quienes aprovecharon", () => {
    expect(k.conversionRate).toBe(33);
    expect(k.revenueCents).toBe(8000);
  });
  it("sin contactados la conversión es null (no 0%)", () => {
    expect(computeBirthdayKpis([]).conversionRate).toBeNull();
    expect(rateOf(0, 0)).toBeNull();
    expect(rateOf(1, 3)).toBe(33);
  });
});

describe("computeFlowBreakdown — por automatización", () => {
  const flows = [
    { id: "a", name: "Saludo del día", active: true },
    { id: "b", name: "Aviso 3 días antes", active: true },
    { id: "c", name: "Vieja sin envíos", active: false },
    { id: "d", name: "Vieja con envíos", active: false },
  ];
  const clients = [
    // Le llegaron a y b, reservó y se atendió con S/ 50.
    facts({ sends: [{ flowId: "a", delivered: true }, { flowId: "b", delivered: true }], attended: true, sales: 1, salesCents: 5000 }),
    // a falló dos veces y luego entregó: cuenta como enviado (no fallido) para a.
    facts({ sends: [{ flowId: "a", delivered: false }, { flowId: "a", delivered: true }], booked: true }),
    // b falló.
    facts({ sends: [{ flowId: "b", delivered: false }] }),
    // d (apagada) entregó.
    facts({ sends: [{ flowId: "d", delivered: true }] }),
  ].map((f) => ({ facts: f, state: birthdayRowState(f) }));
  const out = computeFlowBreakdown(flows, clients);
  const by = (id: string) => out.find((f) => f.id === id);

  it("enviados, fallidos, agendados, aprovechados, conversión y cobrado por flujo", () => {
    expect(by("a")).toMatchObject({ sent: 2, failed: 0, booked: 2, converted: 1, conversionRate: 50, revenueCents: 5000 });
    expect(by("b")).toMatchObject({ sent: 1, failed: 1, booked: 1, converted: 1, conversionRate: 100 });
  });
  it("entran las activas y las apagadas que este año enviaron; una apagada sin envíos no", () => {
    expect(by("d")).toMatchObject({ sent: 1, active: false });
    expect(by("c")).toBeUndefined();
    // Activas primero; luego por enviados.
    expect(out.map((f) => f.id)).toEqual(["a", "b", "d"]);
  });
  it("un flujo sin envíos muestra conversión null", () => {
    const solo = computeFlowBreakdown([{ id: "x", name: "Nueva", active: true }], []);
    expect(solo).toEqual([expect.objectContaining({ id: "x", sent: 0, conversionRate: null })]);
  });
});

describe("filtros rápidos y búsqueda", () => {
  const row = (name: string, phone: string | null, f: BirthdayFacts) => ({ name, phone, ...birthdayRowState(f) });
  const rows = [
    row("Ana Pérez", "51999111222", facts()),
    row("Beto Ruiz", "51999333444", facts({ sends: [{ flowId: "a", delivered: false }] })),
    row("Carla Díaz", null, facts({ manual: true })),
    row("Dani Soto", "51988000111", facts({ booked: true })),
    row("Eva Luna", "51977000222", facts({ attended: true })),
  ];

  it("cada filtro trae lo suyo", () => {
    const names = (filter: Parameters<typeof filterBirthdays>[1]["filter"]) =>
      filterBirthdays(rows, { filter, query: "" }).map((r) => r.name.split(" ")[0]);
    expect(names("todos")).toEqual(["Ana", "Beto", "Carla", "Dani", "Eva"]);
    expect(names("pendientes")).toEqual(["Ana", "Beto"]);
    expect(names("enviados_sin_cita")).toEqual(["Carla"]);
    expect(names("agendados")).toEqual(["Dani", "Eva"]);
    expect(names("aprovecharon")).toEqual(["Eva"]);
  });
  it("los conteos de cada filtro", () => {
    // Sin los datos del rescate (Paso 3), nadie sale en «Para rescatar».
    expect(countByFilter(rows)).toEqual({ todos: 5, pendientes: 2, enviados_sin_cita: 1, agendados: 2, aprovecharon: 1, rescatar: 0 });
  });
  it("busca por nombre sin tildes ni mayúsculas y por teléfono (dígitos)", () => {
    expect(filterBirthdays(rows, { filter: "todos", query: "diaz" }).map((r) => r.name)).toEqual(["Carla Díaz"]);
    expect(filterBirthdays(rows, { filter: "todos", query: "333 444" }).map((r) => r.name)).toEqual(["Beto Ruiz"]);
    // Búsqueda y filtro se combinan.
    expect(filterBirthdays(rows, { filter: "pendientes", query: "eva" })).toEqual([]);
  });
  it("matchesBirthdayFilter: «agendados» es por la cita, no por el estado mostrado", () => {
    expect(matchesBirthdayFilter({ status: "aprovecho", booked: true }, "agendados")).toBe(true);
    expect(matchesBirthdayFilter({ status: "aprovecho", booked: false }, "agendados")).toBe(false);
  });
});

describe("buildBirthdayCampaign — de las filas de la base a la tarjeta", () => {
  const contacts: BirthdayContactRow[] = [
    { id: "ct_1", name: "Ana", phone: "51999111222", day: 3, visits: 4, totalCents: 20000 },
    { id: "ct_2", name: "Beto", phone: null, day: 10, visits: 0, totalCents: 0 },
    { id: "ct_3", name: "Carla", phone: "51999333444", day: 20, visits: 1, totalCents: 4000 },
  ];
  const out = buildBirthdayCampaign({
    contacts,
    flows: [{ id: "aut_1", name: "Saludo", active: true }],
    sends: [
      { contactId: "ct_1", flowId: "aut_1", logStatus: "success", messageStatus: "delivered" },
      { contactId: "ct_2", flowId: "aut_1", logStatus: "success", messageStatus: "failed" },
      { contactId: "ct_3", flowId: "aut_1", logStatus: "skipped_rate_limit", messageStatus: null },
      // Un registro de alguien que no es cumpleañero del mes se ignora.
      { contactId: "ct_x", flowId: "aut_1", logStatus: "success", messageStatus: "sent" },
    ],
    manual: new Set(["ct_3"]),
    bookings: [
      { contactId: "ct_1", status: "realizada" },
      { contactId: "ct_3", status: "cancelada" },
    ],
    sales: [{ contactId: "ct_1", count: 1, cents: 6000 }],
  });
  const of = (id: string) => out.clients.find((c) => c.id === id)!;

  it("estados por cliente, conservando sus datos", () => {
    expect(of("ct_1")).toMatchObject({ status: "aprovecho", contactedBy: "auto", windowRevenueCents: 6000, visits: 4 });
    expect(of("ct_2")).toMatchObject({ status: "fallido", sendFailed: true });
    // La cita cancelada no cuenta; la postergación por tope tampoco es un fallo; el saludo manual sí contacta.
    expect(of("ct_3")).toMatchObject({ status: "enviado", contactedBy: "manual", booked: false, sendFailed: false });
  });
  it("KPIs y desglose salen de los mismos estados", () => {
    expect(out.kpis).toMatchObject({ total: 3, contacted: 2, failed: 1, booked: 1, converted: 1, conversionRate: 50, revenueCents: 6000 });
    expect(out.flows).toEqual([expect.objectContaining({ id: "aut_1", sent: 1, failed: 1, converted: 1, conversionRate: 100 })]);
  });
});

describe("tarjeta del Panel", () => {
  async function render(birthdays: SalonDashboardDto["birthdays"]) {
    const { BirthdaysSection } = await import("@/components/negocio/dashboard-birthdays");
    return renderToStaticMarkup(createElement(BirthdaysSection, { birthdays, currency: "PEN", loading: false, hasData: true }));
  }
  const built = buildBirthdayCampaign({
    contacts: [
      { id: "ct_1", name: "Ana Pérez", phone: "51999111222", day: 3, visits: 4, totalCents: 20000 },
      { id: "ct_2", name: "Beto Ruiz", phone: null, day: 10, visits: 0, totalCents: 0 },
    ],
    flows: [{ id: "aut_1", name: "Saludo del día", active: true }],
    sends: [{ contactId: "ct_1", flowId: "aut_1", logStatus: "success", messageStatus: "read" }],
    manual: new Set(),
    bookings: [],
    sales: [],
  });
  const birthdays: SalonDashboardDto["birthdays"] = {
    month: 11,
    today: 5,
    year: 2026,
    ...built,
    // Sin el módulo de Automatizaciones el bloque del rescate no se dibuja.
    rescue: {
      ...computeRescueSummary(built.clients, "2026-11-05"),
      available: false,
      flows: [],
      benefit: "20% de descuento",
      monthEnd: "30 de noviembre",
      settings: { autoEnabled: false, flowId: null, windowDays: 7, minGapDays: 7, sendHour: 10, benefitText: null },
      lastAutoRunOn: null,
    },
  };

  it("muestra KPIs, desglose, buscador, filtros con conteo, estado por fila y la acción de cada estado", async () => {
    const html = await render(birthdays);
    expect(html).toContain("Cumpleaños de");
    expect(html).toContain("Cumpleañeros del mes");
    expect(html).toContain("Aprovecharon");
    expect(html).toContain("Saludo del día");
    expect(html).toContain('placeholder="Buscar por nombre o teléfono"');
    expect(html).toContain("Sin enviar / Fallidos");
    expect(html).toContain("Enviados sin cita");
    expect(html).toContain('data-estado="enviado"');
    expect(html).toContain('data-estado="sin_enviar"');
    // Ana ya saludada: «Invitar» a reservar. Beto cumple más adelante y hay automatización activa: ella lo envía (sin botón manual).
    expect(html).toContain("Invitar");
    expect(html).toContain("Lo envía la automatización");
    expect(html).not.toContain("Marcar saludado");
    // Paginación estándar.
    expect(html).toContain("Paginación de cumpleaños");
  });

  it("rowAction: saludar registra; agendado lleva a citas; aprovechó no pide nada", async () => {
    const { rowAction } = await import("@/components/negocio/dashboard-birthdays");
    expect(rowAction({ status: "sin_enviar", phone: "51999111222", name: "Ana" })).toMatchObject({
      kind: "link",
      label: "Saludar",
      registers: true,
    });
    expect(rowAction({ status: "fallido", phone: null, name: "Ana" })).toEqual({ kind: "mark" });
    expect(rowAction({ status: "enviado", phone: "51999111222", name: "Ana" })).toMatchObject({ label: "Invitar", registers: false });
    expect(rowAction({ status: "agendado", phone: null, name: "Ana" })).toEqual({ kind: "bookings" });
    expect(rowAction({ status: "aprovecho", phone: "51999111222", name: "Ana" })).toEqual({ kind: "none" });
  });
});
