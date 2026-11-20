import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hallazgo J — el barrido que reintenta proactivamente los adjuntos entrantes pendientes o fallidos, y la anotación del
 * intento en la falla de descarga. Base en memoria que entiende los operadores del prefiltro SQL.
 */

type Fila = Record<string, unknown>;
type Cond = { op: string; col?: string; val?: unknown; args?: Cond[]; arg?: Cond };

const bd = vi.hoisted(() => ({ assets: [] as Record<string, unknown>[], updates: [] as { id: string; set: Record<string, unknown> }[] }));

vi.mock("drizzle-orm", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...original,
    and: (...args: unknown[]) => ({ op: "and", args }),
    or: (...args: unknown[]) => ({ op: "or", args }),
    not: (arg: unknown) => ({ op: "not", arg }),
    eq: (col: string, val: unknown) => ({ op: "eq", col, val }),
    gt: (col: string, val: unknown) => ({ op: "gt", col, val }),
    lt: (col: string, val: unknown) => ({ op: "lt", col, val }),
    like: (col: string, val: string) => ({ op: "like", col, val }),
    inArray: (col: string, val: unknown[]) => ({ op: "in", col, val }),
    isNull: (col: string) => ({ op: "isnull", col }),
    isNotNull: (col: string) => ({ op: "notnull", col }),
    asc: (col: string) => col,
  };
});

vi.mock("@/lib/db", () => {
  const cols = ["id", "organizationId", "kind", "fetchStatus", "waMediaId", "libraryItemId", "fetchError", "createdAt", "updatedAt", "storagePath"];
  return { getDb: () => db, schema: { mediaAsset: Object.fromEntries(cols.map((c) => [c, c])) } };
});

const ev = (w: Cond, r: Fila): boolean | null => {
  const v = w.col ? r[w.col] : undefined;
  switch (w.op) {
    case "and": return (w.args ?? []).every((a) => ev(a, r) === true);
    case "or": return (w.args ?? []).some((a) => ev(a, r) === true);
    case "not": { const x = ev(w.arg!, r); return x === null ? null : !x; }
    case "eq": return v === w.val;
    case "gt": return (v as Date).getTime() > (w.val as Date).getTime();
    case "lt": return (v as Date).getTime() < (w.val as Date).getTime();
    case "in": return (w.val as unknown[]).includes(v);
    case "isnull": return v === null || v === undefined;
    case "notnull": return v !== null && v !== undefined;
    case "like": return v === null || v === undefined ? null : String(v).startsWith(String(w.val).replace(/%$/, ""));
    default: return true;
  }
};

const db = {
  select: () => ({
    from: () => ({
      where: (w: Cond) => ({
        orderBy: () => ({
          limit: async (n: number) =>
            bd.assets
              .filter((r) => ev(w, r) === true)
              .sort((a, b) => (a.updatedAt as Date).getTime() - (b.updatedAt as Date).getTime())
              .slice(0, n),
        }),
      }),
    }),
  }),
};

vi.mock("@/server/whatsapp/media", () => ({ ensureAssetAvailable: vi.fn() }));

import { FALLAS_SEGUIDAS_MAX, LIMITE_POR_TANDA, reintentarAdjuntosPendientes } from "@/server/medios/reintentar-adjuntos";

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
const NOW = new Date("2026-11-20T12:00:00Z");
const hace = (ms: number) => new Date(NOW.getTime() - ms);

function asset(id: string, extra: Fila = {}): Fila {
  return {
    id,
    organizationId: "org_1",
    kind: "video",
    fetchStatus: "failed",
    waMediaId: `wa_${id}`,
    libraryItemId: null,
    fetchError: "[intento 1] R2 caído",
    createdAt: hace(2 * DIA),
    updatedAt: hace(2 * HORA),
    storagePath: null,
    ...extra,
  };
}

/** Un descargador que apunta qué se pidió y responde según el id (por defecto, recupera). */
function descargador(resultado: (id: string) => boolean = () => true) {
  const pedidos: string[] = [];
  return {
    pedidos,
    fn: async (_org: string, id: string) => {
      pedidos.push(id);
      return resultado(id) ? { fetchStatus: "available" } : null;
    },
  };
}

beforeEach(() => {
  bd.assets = [];
  bd.updates = [];
});

describe("reintentarAdjuntosPendientes — qué reintenta", () => {
  it("recupera un fallido pasada su espera y un pendiente viejo; cuenta lo recuperado", async () => {
    bd.assets = [asset("a_fallido"), asset("a_pendiente", { fetchStatus: "pending", fetchError: null, updatedAt: hace(30 * MIN) })];
    const d = descargador();
    const r = await reintentarAdjuntosPendientes({ now: NOW, descargar: d.fn });
    expect(d.pedidos.sort()).toEqual(["a_fallido", "a_pendiente"]);
    expect(r).toMatchObject({ reintentados: 2, recuperados: 2, fallidos: 0, detenido: false });
  });

  it("NO toca: pendiente reciente, fallido en su espera, [gone], vencido (≥ 28 días), agotado, de biblioteca, ya disponible, sin media id", async () => {
    bd.assets = [
      asset("reciente", { fetchStatus: "pending", fetchError: null, updatedAt: hace(2 * MIN) }),
      asset("en_espera", { fetchError: "[intento 4] x", updatedAt: hace(30 * MIN) }),
      asset("gone", { fetchError: "[gone] Meta ya no lo tiene" }),
      asset("vencido", { createdAt: hace(29 * DIA) }),
      asset("agotado", { fetchError: "[intento 40] x" }),
      asset("biblioteca", { libraryItemId: "med_1" }),
      asset("disponible", { fetchStatus: "available" }),
      asset("sin_media", { waMediaId: null }),
      asset("ubicacion", { kind: "location", waMediaId: null }),
    ];
    const d = descargador();
    const r = await reintentarAdjuntosPendientes({ now: NOW, descargar: d.fn });
    expect(d.pedidos).toEqual([]);
    expect(r.reintentados).toBe(0);
  });

  it("un fallo antiguo sin marca ([intento N]) se reintenta como si fuera el primero", async () => {
    bd.assets = [asset("viejo_formato", { fetchError: "Meta no entregó la metadata del adjunto" })];
    const d = descargador();
    await reintentarAdjuntosPendientes({ now: NOW, descargar: d.fn });
    expect(d.pedidos).toEqual(["viejo_formato"]);
  });
});

describe("reintentarAdjuntosPendientes — límites", () => {
  it("a lo sumo LIMITE_POR_TANDA por tanda, empezando por lo menos recientemente intentado", async () => {
    bd.assets = Array.from({ length: 25 }, (_, i) => asset(`a${String(i).padStart(2, "0")}`, { updatedAt: hace((30 - i) * HORA) }));
    const d = descargador();
    const r = await reintentarAdjuntosPendientes({ now: NOW, descargar: d.fn });
    expect(LIMITE_POR_TANDA).toBe(10);
    expect(r.reintentados).toBe(10);
    expect(d.pedidos).toEqual(Array.from({ length: 10 }, (_, i) => `a${String(i).padStart(2, "0")}`)); // los de updatedAt más antiguo
  });

  it("el límite se puede acotar más", async () => {
    bd.assets = Array.from({ length: 6 }, (_, i) => asset(`b${i}`));
    const d = descargador();
    expect((await reintentarAdjuntosPendientes({ now: NOW, limite: 2, descargar: d.fn })).reintentados).toBe(2);
  });

  it("los que están en su espera no le quitan el turno a los demás (se escanean más de los que se reintentan)", async () => {
    bd.assets = [
      ...Array.from({ length: 30 }, (_, i) => asset(`espera${i}`, { fetchError: "[intento 6] x", updatedAt: hace(HORA + i * MIN) })),
      asset("listo", { updatedAt: hace(3 * DIA) }),
    ];
    const d = descargador();
    await reintentarAdjuntosPendientes({ now: NOW, descargar: d.fn });
    expect(d.pedidos).toEqual(["listo"]);
  });

  it("cortacircuitos: con el almacenamiento caído se detiene tras 3 fallas seguidas (no martilla)", async () => {
    bd.assets = Array.from({ length: 10 }, (_, i) => asset(`c${i}`, { updatedAt: hace((20 - i) * HORA) }));
    const d = descargador(() => false);
    const r = await reintentarAdjuntosPendientes({ now: NOW, descargar: d.fn });
    expect(FALLAS_SEGUIDAS_MAX).toBe(3);
    expect(d.pedidos).toHaveLength(3);
    expect(r).toMatchObject({ reintentados: 3, recuperados: 0, fallidos: 3, detenido: true });
  });

  it("un acierto reinicia la cuenta: fallas salteadas no detienen la tanda", async () => {
    bd.assets = Array.from({ length: 8 }, (_, i) => asset(`d${i}`, { updatedAt: hace((20 - i) * HORA) }));
    const d = descargador((id) => ["d2", "d5"].includes(id)); // falla d0 d1, acierta d2, falla d3 d4, acierta d5, falla d6 d7
    const r = await reintentarAdjuntosPendientes({ now: NOW, descargar: d.fn });
    expect(d.pedidos).toHaveLength(8);
    expect(r).toMatchObject({ reintentados: 8, recuperados: 2, fallidos: 6, detenido: false });
  });

  it("una excepción del descargador cuenta como falla y no tumba la tanda", async () => {
    bd.assets = [asset("e0"), asset("e1", { updatedAt: hace(3 * HORA) })];
    const r = await reintentarAdjuntosPendientes({
      now: NOW,
      descargar: async (_o, id) => {
        if (id === "e1") throw new Error("boom");
        return { fetchStatus: "available" };
      },
    });
    expect(r).toMatchObject({ reintentados: 2, recuperados: 1, fallidos: 1 });
  });

  it("sin candidatos no hace nada", async () => {
    const d = descargador();
    expect(await reintentarAdjuntosPendientes({ now: NOW, descargar: d.fn })).toEqual({ revisados: 0, reintentados: 0, recuperados: 0, fallidos: 0, detenido: false });
  });
});
