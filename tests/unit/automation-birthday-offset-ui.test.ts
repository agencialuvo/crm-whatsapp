import { describe, expect, it } from "vitest";
import {
  BIRTHDAY_OFFSETS,
  describeTrigger,
  offsetOf,
  offsetOptionLabel,
  offsetShort,
} from "@/lib/automation-dto";

/** Cumpleaños con adelanto (`daysOffset`) — los textos que lee la persona: opciones del desplegable y cabecera del flujo. */

describe("textos del momento del envío", () => {
  it("opciones: el mismo día, 1 día antes, 2 días antes", () => {
    expect([...BIRTHDAY_OFFSETS]).toEqual([0, -1, -2]);
    expect(offsetOptionLabel(0)).toBe("El mismo día del cumpleaños");
    expect(offsetOptionLabel(-1)).toBe("1 día antes del cumpleaños");
    expect(offsetOptionLabel(-2)).toBe("2 días antes del cumpleaños");
    expect(offsetOptionLabel(-7)).toBe("7 días antes del cumpleaños");
  });
  it("offsetOf lee lo ausente o inválido como 0", () => {
    expect(offsetOf(null)).toBe(0);
    expect(offsetOf({})).toBe(0);
    expect(offsetOf({ daysOffset: -1 })).toBe(-1);
    expect(offsetOf({ daysOffset: 2 })).toBe(0);
    expect(offsetOf({ daysOffset: "-1" })).toBe(0);
    expect(offsetShort(0)).toBeNull();
    expect(offsetShort(-1)).toBe("1 día antes");
  });
  it("la cabecera del flujo lo dice de forma amable", () => {
    expect(describeTrigger("birthday", { hour: 10, daysOffset: -1 })).toBe("Cada cumpleaños (1 día antes), a las 10:00");
    expect(describeTrigger("birthday", { hour: 9, daysOffset: -2 })).toBe("Cada cumpleaños (2 días antes), a las 09:00");
    expect(describeTrigger("birthday", { hour: 8, daysOffset: 0 })).toBe("Cada cumpleaños, a las 08:00");
    expect(describeTrigger("birthday", null)).toBe("Cada cumpleaños, a las 10:00");
  });
});
