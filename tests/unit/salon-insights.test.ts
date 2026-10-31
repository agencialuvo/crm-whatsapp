import { describe, expect, it } from "vitest";
import {
  MIN_CYCLE_INTERVALS,
  computeRepurchase,
  computeTicketSplit,
  daysBetween,
  reminderStatus,
  sortBirthdaysByProximity,
  type CycleClientInput,
} from "@/lib/salon/insights";

describe("ticket: servicios sueltos vs ofertas", () => {
  it("promedio por grupo y diferencia en centavos y porcentaje", () => {
    const s = computeTicketSplit({
      services: { count: 4, revenueCents: 10_000 }, // 2500 c/u
      offers: { count: 2, revenueCents: 7_000 }, // 3500 c/u
    });
    expect(s.services).toEqual({ count: 4, revenueCents: 10_000, avgCents: 2_500 });
    expect(s.offers.avgCents).toBe(3_500);
    expect(s.liftCents).toBe(1_000);
    expect(s.liftPercent).toBe(40);
  });

  it("las ofertas pueden dejar menos que un servicio suelto", () => {
    const s = computeTicketSplit({ services: { count: 1, revenueCents: 4_000 }, offers: { count: 1, revenueCents: 3_000 } });
    expect(s.liftCents).toBe(-1_000);
    expect(s.liftPercent).toBe(-25);
  });

  it("sin ventas de un lado no hay comparación ni división por cero", () => {
    const solo = computeTicketSplit({ services: { count: 3, revenueCents: 9_000 }, offers: { count: 0, revenueCents: 0 } });
    expect(solo.offers.avgCents).toBeNull();
    expect(solo.liftCents).toBeNull();
    expect(solo.liftPercent).toBeNull();
    const nada = computeTicketSplit({ services: { count: 0, revenueCents: 0 }, offers: { count: 0, revenueCents: 0 } });
    expect(nada.services.avgCents).toBeNull();
    expect(nada.liftPercent).toBeNull();
  });

  it("redondea el promedio a centavos enteros", () => {
    expect(computeTicketSplit({ services: { count: 3, revenueCents: 1_000 }, offers: { count: 0, revenueCents: 0 } }).services.avgCents).toBe(333);
  });
});

describe("días entre visitas", () => {
  it("cuenta días enteros, también entre meses y años", () => {
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(30);
    expect(daysBetween("2026-09-30", "2026-10-01")).toBe(1);
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
    expect(daysBetween("2026-10-05", "2026-10-05")).toBe(0);
  });
});

describe("estado frente al ciclo", () => {
  it("por vencer desde el 80 %, vencido desde el 100 %, perdido desde el doble", () => {
    expect(reminderStatus(15, 20)).toBeNull();
    expect(reminderStatus(16, 20)).toBe("soon");
    expect(reminderStatus(19, 20)).toBe("soon");
    expect(reminderStatus(20, 20)).toBe("due");
    expect(reminderStatus(39, 20)).toBe("due");
    expect(reminderStatus(40, 20)).toBe("lost");
  });

  it("un ciclo no válido no avisa", () => {
    expect(reminderStatus(10, 0)).toBeNull();
  });
});

const c = (id: string, ...days: string[]): CycleClientInput => ({ id, name: `Cliente ${id}`, phone: null, days });

describe("ciclo de recompra", () => {
  it("sin clientes con 2 visitas no hay ciclo", () => {
    const r = computeRepurchase([c("a", "2026-10-01"), c("b")], "2026-10-31");
    expect(r).toMatchObject({ avgDays: null, medianDays: null, clients: 0, intervals: 0, reliable: false });
    expect(r.reminders).toEqual({ soon: 0, due: 0, lost: 0, list: [] });
  });

  it("promedio y mediana de los intervalos entre visitas consecutivas", () => {
    // a: 10 y 20 días · b: 30 días → intervalos [10, 20, 30]
    const r = computeRepurchase(
      [c("a", "2026-01-01", "2026-01-11", "2026-01-31"), c("b", "2026-02-01", "2026-03-03")],
      "2026-03-04"
    );
    expect(r.intervals).toBe(3);
    expect(r.avgDays).toBe(20);
    expect(r.medianDays).toBe(20);
    expect(r.clients).toBe(2);
    expect(r.reliable).toBe(false); // < MIN_CYCLE_INTERVALS: no se avisa a nadie
    expect(r.reminders.list).toEqual([]);
  });

  it("varias ventas el mismo día son una sola visita; el orden de entrada no importa", () => {
    const r = computeRepurchase([c("a", "2026-01-11", "2026-01-01", "2026-01-01", "2026-01-11")], "2026-02-01");
    expect(r.intervals).toBe(1);
    expect(r.avgDays).toBe(10);
  });

  it("la mediana no se deja arrastrar por quien volvió tras un año", () => {
    const r = computeRepurchase(
      [c("a", "2026-01-01", "2026-01-15", "2026-01-29", "2026-02-12"), c("b", "2024-01-01", "2026-01-01")],
      "2026-02-13"
    );
    expect(r.medianDays).toBe(14);
    expect(r.avgDays).toBeGreaterThan(100);
  });

  it("con suficientes intervalos clasifica por vencer, vencidos y perdidos (ciclo de 10 días)", () => {
    // Todos los intervalos son de 10 días: el ciclo (mediana) es 10.
    const clients = [
      c("regular", "2026-09-01", "2026-09-11", "2026-09-21", "2026-10-01", "2026-10-11"),
      c("ok", "2026-09-01", "2026-09-11", "2026-09-21", "2026-10-01", "2026-10-11", "2026-10-21"),
    ];
    const r = computeRepurchase(clients, "2026-10-31");
    expect(r.reliable).toBe(true);
    expect(r.medianDays).toBe(10);
    // regular: última 10-11 → 20 días = 200 % → perdido. ok: 10 días = 100 % → le toca.
    expect(r.reminders.lost).toBe(1);
    expect(r.reminders.due).toBe(1);
    expect(r.reminders.soon).toBe(0);
    expect(r.reminders.list.map((x) => [x.id, x.status, x.daysSince])).toEqual([["ok", "due", 10]]);
  });

  it("la lista va del más atrasado al menos, sin perdidos, con tope de 5", () => {
    // Ciclo de 10 días: 8 clientes con 6 visitas cada 10 días, distinta última visita.
    const mk = (id: string, lastShift: number): CycleClientInput => {
      const days: string[] = [];
      for (let i = 0; i < 6; i++) {
        const d = new Date(Date.UTC(2026, 4, 1 + i * 10 + lastShift));
        days.push(d.toISOString().slice(0, 10));
      }
      return { id, name: id, phone: "51999888777", days };
    };
    // Última visita = 2026-05-01 + 50 + shift. asOf elegido para dar 8..19 días sin venir.
    const clients = [mk("c1", 0), mk("c2", 1), mk("c3", 2), mk("c4", 3), mk("c5", 4), mk("c6", 5), mk("c7", 6), mk("c8", 7)];
    const r = computeRepurchase(clients, "2026-07-10"); // c1: 2026-06-20 → 20 días = perdido
    expect(r.reliable).toBe(true);
    expect(r.reminders.lost).toBe(1);
    expect(r.reminders.list.length).toBeLessThanOrEqual(5);
    const ratios = r.reminders.list.map((x) => x.daysSince);
    expect([...ratios].sort((a, b) => b - a)).toEqual(ratios);
    expect(r.reminders.list.every((x) => x.status !== ("lost" as string))).toBe(true);
    expect(MIN_CYCLE_INTERVALS).toBe(5);
  });
});

describe("cumpleaños del mes por cercanía", () => {
  const b = (day: number, name: string) => ({ day, name });

  it("hoy primero, luego los próximos y al final los que ya pasaron (el más reciente antes)", () => {
    const list = [b(2, "Ana"), b(10, "Beto"), b(15, "Carla"), b(20, "Diego"), b(28, "Elena"), b(14, "Fran"), b(31, "Gus")];
    expect(sortBirthdaysByProximity(list, 15).map((x) => x.day)).toEqual([15, 20, 28, 31, 14, 10, 2]);
  });

  it("el día 1 (sin pasados) queda en orden ascendente", () => {
    expect(sortBirthdaysByProximity([b(30, "A"), b(1, "B"), b(12, "C")], 1).map((x) => x.day)).toEqual([1, 12, 30]);
  });

  it("a fin de mes los pasados van del más cercano al más lejano", () => {
    expect(sortBirthdaysByProximity([b(1, "A"), b(29, "B"), b(30, "C"), b(31, "D")], 30).map((x) => x.day)).toEqual([30, 31, 29, 1]);
  });

  it("mismo día: por nombre; no modifica la lista original", () => {
    const list = [b(5, "Zoe"), b(5, "Ana")];
    expect(sortBirthdaysByProximity(list, 1).map((x) => x.name)).toEqual(["Ana", "Zoe"]);
    expect(list[0]!.name).toBe("Zoe");
  });
});
