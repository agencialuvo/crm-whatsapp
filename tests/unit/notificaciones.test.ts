import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_FILTERS,
  NOTIFICATION_FILTER_LABELS,
  filterCategory,
  timeAgo,
} from "@/lib/notifications";
import { appNavGroups } from "@/lib/nav";

describe("notificaciones — filtros y tiempo relativo", () => {
  it("cada pestaña tiene su etiqueta y las de categoría filtran la suya", () => {
    expect(NOTIFICATION_FILTERS.map((f) => NOTIFICATION_FILTER_LABELS[f])).toEqual([
      "Todas",
      "No leídas",
      "Citas",
      "WhatsApp",
    ]);
    expect(filterCategory("todas")).toBeNull();
    expect(filterCategory("no_leidas")).toBeNull();
    expect(filterCategory("citas")).toBe("cita");
    expect(filterCategory("whatsapp")).toBe("whatsapp");
  });

  it("timeAgo: momento, minutos, horas y días", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(timeAgo(ago(10_000), now)).toBe("hace un momento");
    expect(timeAgo(ago(5 * 60_000), now)).toBe("hace 5 min");
    expect(timeAgo(ago(3 * 3_600_000), now)).toBe("hace 3 h");
    expect(timeAgo(ago(49 * 3_600_000), now)).toBe("hace 2 d");
    // Un reloj adelantado no da tiempos negativos.
    expect(timeAgo(new Date(now + 60_000).toISOString(), now)).toBe("hace un momento");
  });

  it("el menú lleva «Notificaciones» para cualquier rol", () => {
    for (const role of ["owner", "member", null]) {
      const hrefs = appNavGroups({ salon: true, agenda: true, role }).flatMap((g) =>
        g.items.map((i) => i.href)
      );
      expect(hrefs, String(role)).toContain("/notificaciones");
    }
  });
});
