import { describe, expect, it } from "vitest";
import { normalizeBranding } from "@/lib/branding";
import { TIMEZONES, timezoneSelectOptions, utcOffsetLabel } from "@/lib/timezones";
import { isValidTimeZone } from "@/lib/time/slots";

describe("zonas horarias del negocio", () => {
  it("todas las zonas de la lista las entiende el motor y no se repiten", () => {
    for (const t of TIMEZONES) expect(isValidTimeZone(t.id), t.id).toBe(true);
    expect(new Set(TIMEZONES.map((t) => t.id)).size).toBe(TIMEZONES.length);
  });

  it("muestra el desfase UTC de cada zona", () => {
    const enero = new Date("2026-01-15T12:00:00Z");
    expect(utcOffsetLabel("America/Mexico_City", enero)).toBe("UTC−6");
    expect(utcOffsetLabel("America/Lima", enero)).toBe("UTC−5");
    expect(utcOffsetLabel("Europe/Madrid", enero)).toBe("UTC+1");
    expect(utcOffsetLabel("UTC", enero)).toBe("UTC");
    expect(utcOffsetLabel("No/Existe", enero)).toBe("");
  });

  it("una zona válida fuera de la lista se conserva en el desplegable; una inválida no entra", () => {
    expect(timezoneSelectOptions("Asia/Tokyo").map((o) => o.value)).toContain("Asia/Tokyo");
    expect(timezoneSelectOptions("No/Existe").map((o) => o.value)).not.toContain("No/Existe");
    expect(timezoneSelectOptions("America/Lima").filter((o) => o.value === "America/Lima")).toHaveLength(1);
  });
});

describe("marca — zona horaria", () => {
  it("conserva una zona válida y descarta una desconocida", () => {
    expect(normalizeBranding({ timezone: " America/Lima " }).timezone).toBe("America/Lima");
    expect(normalizeBranding({ timezone: "No/Existe" }).timezone).toBeNull();
    expect(normalizeBranding({}).timezone).toBeNull();
    expect(normalizeBranding(null).timezone).toBeNull();
  });
});
