import { describe, expect, it } from "vitest";
import {
  decodeListCursor,
  decodeThreadCursor,
  encodeListCursor,
  encodeThreadCursor,
} from "@/lib/inbox-cursor";
import {
  applyDelta,
  DEFAULT_FILTERS,
  insertSorted,
  isNearBottom,
  isOlderThanSeen,
  latestOnly,
  matchesFilters,
  mergeById,
  patchRow,
  puedeMarcarLeido,
  removeRow,
  upsertMany,
  type ListRow,
} from "@/lib/inbox-state";
import { clockOffsetMs, nextTickMs, windowStateAt } from "@/lib/inbox-window";
import { matchesQuery } from "@/lib/search";
import type { ConversationDto, MessageDto } from "@/lib/types";

/** 042 — Lo delicado del cliente de la bandeja, sin red ni pantalla. La contraparte SQL: bandeja-escala-live. */

let n = 0;
function conv(over: Partial<ConversationDto> & { id?: string } = {}): ConversationDto {
  const i = ++n;
  return {
    id: over.id ?? `cv_${String(i).padStart(3, "0")}`,
    channel: "whatsapp",
    contact: { id: `ct_${i}`, name: `Cliente ${i}`, phone: `5215500000${String(i).padStart(2, "0")}` },
    stageName: "Nuevo",
    aiEnabled: true,
    handoffAt: null,
    handoffReason: null,
    lastInboundAt: null,
    lastMessageAt: null,
    sortKey: `2026-11-17T10:${String(i).padStart(2, "0")}:00.000Z`,
    unreadCount: 0,
    windowOpen: false,
    windowRemainingMs: 0,
    windowExpiresAt: null,
    humanWindow: null,
    composer: { media: true, structured: true },
    preview: null,
    anuncio: null,
    ...over,
  };
}
const rowsOf = (list: ConversationDto[], at = 1): ListRow[] => upsertMany([], list, at);
const ids = (rows: ListRow[]) => rows.map((r) => r.dto.id);

function msg(id: string, iso: string, over: Partial<MessageDto> = {}): MessageDto {
  return {
    id,
    conversationId: "cv_1",
    direction: "in",
    type: "text",
    text: id,
    status: "delivered",
    error: null,
    aiGenerated: false,
    origin: "operator",
    media: null,
    createdAt: iso,
    ...over,
  };
}

describe("cursores", () => {
  it("ida y vuelta, conservando los microsegundos", () => {
    const c = { k: "2026-11-17 10:00:00.123456", id: "cv_abc" };
    expect(decodeListCursor(encodeListCursor(c))).toEqual(c);
    const t = { t: "2026-11-17 10:00:00.5", c: "2026-11-17 10:00:01.000001", id: "msg_x" };
    expect(decodeThreadCursor(encodeThreadCursor(t))).toEqual(t);
  });
  it("uno manipulado, truncado o de otra forma no pasa", () => {
    expect(decodeListCursor("no-es-un-cursor")).toBeNull();
    expect(decodeListCursor(Buffer.from(JSON.stringify({ k: "ayer", id: "x" })).toString("base64url"))).toBeNull();
    expect(
      decodeListCursor(Buffer.from(JSON.stringify({ k: "2026-11-17 10:00:00", id: "x'; drop table--" })).toString("base64url"))
    ).toBeNull();
    expect(decodeThreadCursor(encodeListCursor({ k: "2026-11-17 10:00:00", id: "x" }))).toBeNull();
    expect(decodeListCursor("a".repeat(500))).toBeNull();
  });
});

describe("la lista", () => {
  it("se ordena por llave de orden descendente y desempata por id", () => {
    const a = conv({ id: "cv_a", sortKey: "2026-11-17T10:00:00.000Z" });
    const b = conv({ id: "cv_b", sortKey: "2026-11-17T10:00:00.000Z" });
    const c = conv({ id: "cv_c", sortKey: "2026-11-17T11:00:00.000Z" });
    expect(ids(rowsOf([a, b, c]))).toEqual(["cv_c", "cv_b", "cv_a"]);
  });

  it("un parche local (marcar leído) sobrevive a un delta que salió ANTES que él", () => {
    const a = conv({ id: "cv_a", unreadCount: 3 });
    let rows = rowsOf([a], 100);
    rows = patchRow(rows, "cv_a", { unreadCount: 0 }, 200); // el operador la leyó a las 200
    rows = upsertMany(rows, [{ ...a, unreadCount: 3 }], 150); // llega un delta fechado a las 150
    expect(rows[0]!.dto.unreadCount).toBe(0);
    rows = upsertMany(rows, [{ ...a, unreadCount: 1 }], 300); // uno posterior sí manda
    expect(rows[0]!.dto.unreadCount).toBe(1);
  });

  it("removeRow quita por id", () => {
    expect(ids(removeRow(rowsOf([conv({ id: "cv_a" }), conv({ id: "cv_b" })]), "cv_a"))).toEqual(["cv_b"]);
  });

  describe("matchesFilters", () => {
    const c = conv({
      contact: { id: "ct_1", name: "José Pérez", phone: "525550001234" },
      stageName: "Citado",
      unreadCount: 2,
      channel: "instagram",
      anuncio: { headline: "x", sourceId: "1", sourceType: "ad" },
    });
    it("sin filtros todo pasa", () => expect(matchesFilters(c, DEFAULT_FILTERS)).toBe(true));
    it("búsqueda sin acentos, por teléfono tecleado como se ve, y mínimo de 3 dígitos", () => {
      expect(matchesFilters(c, { ...DEFAULT_FILTERS, q: "jose" })).toBe(true);
      expect(matchesFilters(c, { ...DEFAULT_FILTERS, q: "+52 555 000 1234" })).toBe(true);
      expect(matchesFilters(c, { ...DEFAULT_FILTERS, q: "1" })).toBe(false);
      expect(matchesFilters(c, { ...DEFAULT_FILTERS, q: "zzz" })).toBe(false);
    });
    it("etapa, canal, no leídas y anuncios", () => {
      expect(matchesFilters(c, { ...DEFAULT_FILTERS, stage: "Citado" })).toBe(true);
      expect(matchesFilters(c, { ...DEFAULT_FILTERS, stage: "Nuevo" })).toBe(false);
      expect(matchesFilters(c, { ...DEFAULT_FILTERS, channel: "instagram" })).toBe(true);
      expect(matchesFilters(c, { ...DEFAULT_FILTERS, channel: "whatsapp" })).toBe(false);
      expect(matchesFilters(c, { ...DEFAULT_FILTERS, filter: "unread" })).toBe(true);
      expect(matchesFilters({ ...c, unreadCount: 0 }, { ...DEFAULT_FILTERS, filter: "unread" })).toBe(false);
      expect(matchesFilters(c, { ...DEFAULT_FILTERS, filter: "anuncios" })).toBe(true);
      expect(matchesFilters({ ...c, anuncio: null }, { ...DEFAULT_FILTERS, filter: "anuncios" })).toBe(false);
    });
    it("coincide con matchesQuery, la regla que ya usa Contactos", () => {
      for (const q of ["jose", "PÉREZ", "1234", "525", "55 5000", "", "  ", "nadie"]) {
        expect(matchesFilters(c, { ...DEFAULT_FILTERS, q }), q).toBe(
          matchesQuery(q, { text: [c.contact.name], phone: c.contact.phone })
        );
      }
    });
  });

  describe("applyDelta", () => {
    const a = conv({ id: "cv_a", sortKey: "2026-11-17T10:00:00.000Z", unreadCount: 1 });
    const b = conv({ id: "cv_b", sortKey: "2026-11-17T09:00:00.000Z" });

    it("una conversación que cambió sube y se reordena", () => {
      const rows = rowsOf([a, b]);
      const out = applyDelta(rows, [{ ...b, sortKey: "2026-11-17T12:00:00.000Z" }], DEFAULT_FILTERS, 2, false);
      expect(ids(out)).toEqual(["cv_b", "cv_a"]);
    });

    it("una que deja de cumplir el filtro se retira (leída, con «No leídas» puesto)", () => {
      const f = { ...DEFAULT_FILTERS, filter: "unread" as const };
      const out = applyDelta(rowsOf([a]), [{ ...a, unreadCount: 0 }], f, 2, false);
      expect(out).toHaveLength(0);
    });

    it("una nueva que cabe en lo cargado entra; una que cae MÁS ABAJO del último renglón cargado no", () => {
      const rows = rowsOf([a, b]);
      const dentro = conv({ id: "cv_n1", sortKey: "2026-11-17T09:30:00.000Z" });
      const fuera = conv({ id: "cv_n2", sortKey: "2026-11-17T01:00:00.000Z" });
      expect(ids(applyDelta(rows, [dentro, fuera], DEFAULT_FILTERS, 2, true))).toEqual(["cv_a", "cv_n1", "cv_b"]);
      // sin más páginas, la de abajo SÍ entra: no hay nada que cargar después
      expect(ids(applyDelta(rows, [fuera], DEFAULT_FILTERS, 2, false))).toEqual(["cv_a", "cv_b", "cv_n2"]);
    });

    it("no pisa un parche local más reciente", () => {
      const rows = patchRow(rowsOf([a], 1), "cv_a", { unreadCount: 0 }, 50);
      const out = applyDelta(rows, [{ ...a, unreadCount: 5 }], DEFAULT_FILTERS, 10, false);
      expect(out[0]!.dto.unreadCount).toBe(0);
    });
  });
});

describe("el hilo", () => {
  const m1 = msg("m1", "2026-11-17T10:00:00.000Z");
  const m3 = msg("m3", "2026-11-17T10:05:00.000Z", { direction: "out" });

  it("un entrante retrasado por Meta cae en su lugar, no al final", () => {
    const tarde = msg("m2", "2026-11-17T10:02:00.000Z");
    expect(insertSorted([m1, m3], tarde).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("un mensaje con la hora más reciente va al final; con empate, después de los iguales", () => {
    const igual = msg("m4", "2026-11-17T10:05:00.000Z");
    expect(insertSorted([m1, m3], igual).map((m) => m.id)).toEqual(["m1", "m3", "m4"]);
  });

  it("no duplica: el mismo id se reemplaza (así un acuse actualiza la burbuja)", () => {
    const leido = { ...m3, status: "read" as const };
    const out = insertSorted([m1, m3], leido);
    expect(out).toHaveLength(2);
    expect(out[1]!.status).toBe("read");
  });

  it("mergeById conserva las páginas antiguas, trae las nuevas y deja ganar a lo que llega", () => {
    const viejo = msg("m0", "2026-11-17T09:00:00.000Z");
    const out = mergeById([viejo, m1, m3], [{ ...m3, status: "read" }, msg("m5", "2026-11-17T10:10:00.000Z")]);
    expect(out.map((m) => m.id)).toEqual(["m0", "m1", "m3", "m5"]);
    expect(out.find((m) => m.id === "m3")!.status).toBe("read");
  });

  it("los separadores de día no retroceden: tras ordenar, las fechas nunca bajan", () => {
    const desordenados = [
      msg("a", "2026-11-17T23:50:00.000Z"),
      msg("b", "2026-11-16T23:59:00.000Z"), // el entrante retrasado, de AYER
      msg("c", "2026-11-18T00:10:00.000Z"),
    ];
    const orden = desordenados.reduce<MessageDto[]>((acc, m) => insertSorted(acc, m), []);
    const dias = orden.map((m) => new Date(m.createdAt).toISOString().slice(0, 10));
    expect([...dias].sort()).toEqual(dias);
  });

  it("un mensaje por encima de lo ya visto no cuenta como «nuevo»", () => {
    expect(isOlderThanSeen(msg("x", "2026-11-17T10:01:00.000Z"), m3)).toBe(true);
    expect(isOlderThanSeen(msg("y", "2026-11-17T10:06:00.000Z"), m3)).toBe(false);
    expect(isOlderThanSeen(msg("z", "2026-11-17T10:06:00.000Z"), undefined)).toBe(false);
  });
});

describe("scroll y lectura", () => {
  it("«cerca del fondo» son 120 px", () => {
    expect(isNearBottom({ scrollTop: 880, clientHeight: 500, scrollHeight: 1500 })).toBe(true); // 120 justos
    expect(isNearBottom({ scrollTop: 879, clientHeight: 500, scrollHeight: 1500 })).toBe(false);
    expect(isNearBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 400 })).toBe(true); // hilo corto
  });
  it("solo se marca leído con la pestaña a la vista", () => {
    expect(puedeMarcarLeido("visible")).toBe(true);
    expect(puedeMarcarLeido("hidden")).toBe(false);
    expect(puedeMarcarLeido("prerender")).toBe(false);
  });
});

describe("latestOnly: una respuesta vieja nunca pisa a una nueva", () => {
  it("de dos peticiones, solo la última vale, llegue en el orden que llegue", async () => {
    const guard = latestOnly({ abortPrevious: false });
    const aplicado: string[] = [];
    const pedir = async (nombre: string, ms: number) => {
      const req = guard.begin();
      await new Promise((r) => setTimeout(r, ms));
      if (req.current()) aplicado.push(nombre);
    };
    await Promise.all([pedir("lenta", 40), pedir("rapida", 5)]);
    expect(aplicado).toEqual(["rapida"]);
  });

  it("la anterior se cancela por señal cuando así se pide", () => {
    const guard = latestOnly();
    const primera = guard.begin();
    guard.begin();
    expect(primera.signal.aborted).toBe(true);
    expect(primera.current()).toBe(false);
  });

  it("cancel() invalida lo que viaja (cambió el filtro)", () => {
    const guard = latestOnly();
    const req = guard.begin();
    guard.cancel();
    expect(req.current()).toBe(false);
    expect(req.signal.aborted).toBe(true);
  });
});

describe("la ventana corre en el cliente", () => {
  const T0 = Date.parse("2026-11-17T10:00:00.000Z");
  const base = { windowOpen: true, windowExpiresAt: new Date(T0 + 70_000).toISOString(), humanWindow: null };

  it("abre y cierra a la hora exacta, sin pedir nada", () => {
    expect(windowStateAt(base, T0).standardOpen).toBe(true);
    expect(windowStateAt(base, T0 + 69_999).standardOpen).toBe(true);
    expect(windowStateAt(base, T0 + 70_000).standardOpen).toBe(false);
    expect(windowStateAt(base, T0 + 70_000).remainingMs).toBe(0);
    expect(windowStateAt(base, T0).remainingMs).toBe(70_000);
  });

  it("sin entrantes (cerrada) no se abre sola; un canal sin ventana no vence jamás", () => {
    expect(windowStateAt({ windowOpen: false, windowExpiresAt: null, humanWindow: null }, T0).standardOpen).toBe(false);
    const sinVentana = windowStateAt({ windowOpen: true, windowExpiresAt: null, humanWindow: null }, T0 + 9e12);
    expect(sinVentana.standardOpen).toBe(true);
    expect(sinVentana.remainingMs).toBe(Infinity);
  });

  it("la ventana humana: al cerrar la normal, una persona sigue pudiendo contestar hasta su plazo", () => {
    const w = {
      windowOpen: true,
      windowExpiresAt: new Date(T0 + 1000).toISOString(),
      humanWindow: { open: false, remainingMs: 0, expiresAt: new Date(T0 + 7 * 86_400_000).toISOString() },
    };
    expect(windowStateAt(w, T0).standardOpen).toBe(true);
    expect(windowStateAt(w, T0).humanOpen).toBe(false);
    const despues = windowStateAt(w, T0 + 2000);
    expect(despues.standardOpen).toBe(false);
    expect(despues.humanOpen).toBe(true);
    expect(despues.remainingMs).toBe(7 * 86_400_000 - 2000);
    expect(windowStateAt(w, T0 + 7 * 86_400_000).humanOpen).toBe(false);
  });

  it("late cada minuto y cada segundo en los últimos 5 minutos; sin nada que vigilar, no late", () => {
    const en = (ms: number) => ({ windowOpen: true, windowExpiresAt: new Date(T0 + ms).toISOString(), humanWindow: null });
    expect(nextTickMs(en(3_600_000), T0)).toBe(60_000);
    expect(nextTickMs(en(300_000), T0)).toBe(1000);
    expect(nextTickMs(en(70_000), T0)).toBe(1000);
    expect(nextTickMs(en(70_000), T0 + 70_000)).toBeNull(); // ya cerró
    expect(nextTickMs({ windowOpen: false, windowExpiresAt: null, humanWindow: null }, T0)).toBeNull();
  });

  it("el desfase de relojes se calcula con el del servidor", () => {
    expect(clockOffsetMs("2026-11-17T10:00:05.000Z", T0)).toBe(5000);
    expect(clockOffsetMs("basura", T0)).toBe(0);
    // un navegador con el reloj 5 s atrasado cierra a la hora del SERVIDOR, no a la suya
    const offset = clockOffsetMs("2026-11-17T10:00:05.000Z", T0);
    expect(windowStateAt(base, T0 + offset + 65_000).standardOpen).toBe(false);
  });
});
