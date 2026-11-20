import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hallazgo F — la caché del `media_id` ante la concurrencia: una ráfaga de envíos que encuentra el mismo id vencido
 * renueva UNA sola vez, y la invalidación solo borra el id que falló (nunca uno ya renovado por otro envío).
 *
 * Sin base real: una base en memoria que entiende los `eq`/`and` de la caché, con la transacción serializada (lo mismo
 * que hace el candado de Postgres por (medio, número)). La prueba con DOS instancias del módulo cubre el camino entre
 * procesos, donde el único freno es ese candado y la relectura dentro de él.
 */

type Fila = {
  id: string;
  organizationId: string;
  mediaItemId: string;
  phoneNumberId: string;
  waMediaId: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: Date;
  expiresAt: Date;
};

const store = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  cola: Promise.resolve() as Promise<unknown>,
  /** Transacciones abiertas AHORA, y las veces que la E/S de red (R2 / Meta) ocurrió con una abierta. */
  abiertas: 0,
  /** Marca el contexto asíncrono que corre DENTRO de una transacción: la E/S de red no debe ocurrir en él. */
  enTx: null as unknown as import("node:async_hooks").AsyncLocalStorage<boolean>,
  transacciones: 0,
  redConTransaccion: [] as string[],
  /** Para simular un fallo al guardar el id real y un archivo que ya no está. */
  falloAlGuardar: false,
  archivoAusente: false,
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...original,
    eq: (col: string, val: unknown) => ({ op: "eq", col, val }),
    and: (...args: unknown[]) => ({ op: "and", args: args.filter((a) => a !== undefined) }),
    lt: (col: string, val: Date) => ({ op: "lt", col, val }),
    sql: () => ({ op: "sql" }),
  };
});

type Cond = { op: string; col?: string; val?: unknown; args?: Cond[] };
const coincide = (w: Cond, r: Record<string, unknown>): boolean => {
  if (w.op === "and") return (w.args ?? []).every((a) => coincide(a, r));
  if (w.op === "eq") return r[w.col!] === w.val;
  if (w.op === "lt") return (r[w.col!] as Date).getTime() < (w.val as Date).getTime();
  return true;
};

function consulta() {
  return {
    from: () => ({
      where: (w: Cond) => ({ limit: async (n: number) => store.rows.filter((r) => coincide(w, r)).slice(0, n) }),
    }),
  };
}

const insertar = () => ({
  values: (v: Record<string, unknown>) => ({
    onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
      // Guardar el id REAL (no el arrendamiento) puede fallar a propósito.
      if (store.falloAlGuardar && !String(set.waMediaId).startsWith("pending:")) throw new Error("BD caída al guardar");
      const i = store.rows.findIndex((r) => r.mediaItemId === v.mediaItemId && r.phoneNumberId === v.phoneNumberId);
      if (i >= 0) store.rows[i] = { ...store.rows[i], ...set };
      else store.rows.push(v);
    },
  }),
});

const db = {
  select: consulta,
  insert: insertar,
  delete: () => ({
    where: (w: Cond) => {
      const fuera = store.rows.filter((r) => coincide(w, r));
      store.rows = store.rows.filter((r) => !coincide(w, r));
      return Object.assign(Promise.resolve(), { returning: async () => fuera.map((r) => ({ id: r.id })) });
    },
  }),
  // El candado de Postgres: una transacción por vez (aquí, para todo; en la práctica, por (medio, número)). Cuenta cuántas
  // hay abiertas para comprobar que la E/S de red nunca ocurre dentro de una.
  transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
    const turno = store.cola.then(async () => {
      store.abiertas++;
      store.transacciones++;
      try {
        // Todo lo que el callback inicie (y espere) corre con `enTx` activo: ahí NO debe haber E/S de red.
        return await store.enTx.run(true, () => cb({ execute: async () => [], select: consulta, insert: insertar }));
      } finally {
        store.abiertas--;
      }
    });
    store.cola = turno.catch(() => {});
    return turno;
  },
};

vi.mock("@/lib/db", () => ({
  getDb: () => db,
  schema: {
    whatsappMediaCache: Object.fromEntries(
      ["id", "organizationId", "mediaItemId", "phoneNumberId", "waMediaId", "mimeType", "sizeBytes", "uploadedAt", "expiresAt"].map((k) => [k, k])
    ),
  },
}));
vi.mock("@/lib/db/tenant", () => ({
  scoped: (col: string, org: string, ...conds: Cond[]) => ({ op: "and", args: [{ op: "eq", col, val: org }, ...conds.filter(Boolean)] }),
}));
vi.mock("@/server/medios/store", () => ({
  // La lectura de R2: no debe ocurrir con una transacción abierta.
  leerBytesDeMedio: async () => {
    if (store.enTx.getStore()) store.redConTransaccion.push("r2");
    await new Promise((r) => setTimeout(r, 5));
    return store.archivoAusente ? null : Buffer.from("bytes");
  },
}));
vi.mock("@/server/whatsapp/media", () => ({ uploadGraphMedia: vi.fn() }));

store.enTx = new AsyncLocalStorage<boolean>();

const NOW = new Date("2026-11-20T12:00:00Z");
const ITEM = { id: "med_1", organizationId: "org_1", name: "foto", mimeType: "image/png", sizeBytes: 100 } as never;
const CREDS = { organizationId: "org_1", phoneNumberId: "pn_1", token: "t" } as never;

function fila(waMediaId: string, extra: Partial<Fila> = {}): Record<string, unknown> {
  return {
    id: `wmc_${waMediaId}`,
    organizationId: "org_1",
    mediaItemId: "med_1",
    phoneNumberId: "pn_1",
    waMediaId,
    mimeType: "image/png",
    sizeBytes: 100,
    uploadedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 20 * 86_400_000),
    ...extra,
  };
}

/** Una subida a Meta simulada: tarda un poco (para que la ráfaga se solape) y devuelve un id nuevo cada vez. */
function uploader() {
  const calls: number[] = [];
  const fn = async () => {
    // La subida a Meta: tampoco debe ocurrir con una transacción abierta.
    if (store.enTx.getStore()) store.redConTransaccion.push("meta");
    calls.push(calls.length + 1);
    await new Promise((r) => setTimeout(r, 15));
    return `NEW-${calls.length}`;
  };
  return { fn, calls };
}

async function cargar() {
  vi.resetModules();
  return import("@/server/whatsapp/media-cache");
}

beforeEach(() => {
  store.rows = [];
  store.cola = Promise.resolve();
  store.abiertas = 0;
  store.transacciones = 0;
  store.redConTransaccion = [];
  store.falloAlGuardar = false;
  store.archivoAusente = false;
});

describe("renovación (forceRefresh) ante la concurrencia", () => {
  it("50 envíos que rechazan el MISMO id vencido suben el archivo UNA sola vez y todos reciben el id nuevo", async () => {
    const cache = await cargar();
    store.rows = [fila("OLD")];
    const up = uploader();
    const resultados = await Promise.all(
      Array.from({ length: 50 }, () => cache.resolveWaMediaId(ITEM, CREDS, { forceRefresh: true, rejectedWaMediaId: "OLD", upload: up.fn as never, now: () => NOW }))
    );
    expect(up.calls).toHaveLength(1);
    expect(new Set(resultados.map((r) => r.waMediaId))).toEqual(new Set(["NEW-1"]));
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.waMediaId).toBe("NEW-1");
  });

  it("forceRefresh sin id rechazado (uso anterior) también se junta en una sola subida dentro del proceso", async () => {
    const cache = await cargar();
    store.rows = [fila("OLD")];
    const up = uploader();
    const r = await Promise.all(
      Array.from({ length: 10 }, () => cache.resolveWaMediaId(ITEM, CREDS, { forceRefresh: true, upload: up.fn as never, now: () => NOW, pollMs: 5 }))
    );
    expect(up.calls).toHaveLength(1);
    expect(new Set(r.map((x) => x.waMediaId)).size).toBe(1);
  });

  it("si otro envío ya renovó el id (la caché trae uno distinto y vigente), se reutiliza: cero subidas", async () => {
    const cache = await cargar();
    store.rows = [fila("RENOVADO")];
    const up = uploader();
    const r = await cache.resolveWaMediaId(ITEM, CREDS, { forceRefresh: true, rejectedWaMediaId: "OLD", upload: up.fn as never, now: () => NOW });
    expect(r).toEqual({ waMediaId: "RENOVADO", reused: true });
    expect(up.calls).toHaveLength(0);
  });

  it("pero si el id vigente ES el rechazado, no se reutiliza: se renueva", async () => {
    const cache = await cargar();
    store.rows = [fila("OLD")];
    const up = uploader();
    const r = await cache.resolveWaMediaId(ITEM, CREDS, { forceRefresh: true, rejectedWaMediaId: "OLD", upload: up.fn as never, now: () => NOW });
    expect(r).toEqual({ waMediaId: "NEW-1", reused: false });
    expect(up.calls).toHaveLength(1);
  });

  it("entre procesos: dos instancias del módulo (sin memoria compartida) también suben una sola vez gracias al candado + relectura", async () => {
    const a = await cargar();
    const b = await cargar();
    store.rows = [fila("OLD")];
    const up = uploader();
    const opts = { forceRefresh: true, rejectedWaMediaId: "OLD", upload: up.fn as never, now: () => NOW, pollMs: 5 };
    const [ra, rb] = await Promise.all([a.resolveWaMediaId(ITEM, CREDS, opts), b.resolveWaMediaId(ITEM, CREDS, opts)]);
    expect(up.calls).toHaveLength(1);
    expect(ra.waMediaId).toBe("NEW-1");
    expect(rb.waMediaId).toBe("NEW-1");
    expect([ra.reused, rb.reused].sort()).toEqual([false, true]);
    expect(store.redConTransaccion).toEqual([]);
  });

  it("el camino normal (sin forceRefresh) sigue igual: vigente se reutiliza, sin caché sube una vez", async () => {
    const cache = await cargar();
    const up = uploader();
    const todas = await Promise.all(Array.from({ length: 20 }, () => cache.resolveWaMediaId(ITEM, CREDS, { upload: up.fn as never, now: () => NOW })));
    expect(up.calls).toHaveLength(1);
    expect(new Set(todas.map((r) => r.waMediaId))).toEqual(new Set(["NEW-1"]));
    const otra = await cache.resolveWaMediaId(ITEM, CREDS, { upload: up.fn as never, now: () => NOW });
    expect(otra).toEqual({ waMediaId: "NEW-1", reused: true });
    expect(up.calls).toHaveLength(1);
  });
});

describe("invalidación segura", () => {
  it("borra la fila solo si sigue guardando el id que falló", async () => {
    const cache = await cargar();
    store.rows = [fila("OLD")];
    expect(await cache.invalidateWaMediaId(ITEM, "pn_1", "OLD")).toBe(true);
    expect(store.rows).toHaveLength(0);
  });

  it("NO borra un id ya renovado por otro envío", async () => {
    const cache = await cargar();
    store.rows = [fila("RENOVADO")];
    expect(await cache.invalidateWaMediaId(ITEM, "pn_1", "OLD")).toBe(false);
    expect(store.rows.map((r) => r.waMediaId)).toEqual(["RENOVADO"]);
  });

  it("sin id indicado borra incondicionalmente (uso manual), y solo el par (medio, número) pedido", async () => {
    const cache = await cargar();
    store.rows = [fila("A"), fila("B", { id: "wmc_b", phoneNumberId: "pn_2" })];
    expect(await cache.invalidateWaMediaId(ITEM, "pn_1")).toBe(true);
    expect(store.rows.map((r) => r.waMediaId)).toEqual(["B"]);
  });

  it("la carrera completa: A y B rechazan el mismo id; A lo invalida y renueva, B no borra el nuevo y lo reutiliza", async () => {
    const cache = await cargar();
    store.rows = [fila("OLD")];
    const up = uploader();
    const reintento = async () => {
      const borro = await cache.invalidateWaMediaId(ITEM, "pn_1", "OLD");
      const r = await cache.resolveWaMediaId(ITEM, CREDS, { forceRefresh: true, rejectedWaMediaId: "OLD", upload: up.fn as never, now: () => NOW });
      return { borro, r };
    };
    const [a, b] = await Promise.all([reintento(), reintento()]);
    expect([a.borro, b.borro].filter(Boolean)).toHaveLength(1); // solo UNO borra el viejo
    expect(up.calls).toHaveLength(1);
    expect(a.r.waMediaId).toBe("NEW-1");
    expect(b.r.waMediaId).toBe("NEW-1");
    expect(store.rows.map((r) => r.waMediaId)).toEqual(["NEW-1"]);
  });
});

describe("Hallazgo G — la E/S de red no retiene una transacción de Postgres", () => {
  it("la lectura de R2 y la subida a Meta ocurren con CERO transacciones abiertas (solo hubo una corta, para reclamar)", async () => {
    const cache = await cargar();
    const up = uploader();
    await cache.resolveWaMediaId(ITEM, CREDS, { upload: up.fn as never, now: () => NOW });
    expect(up.calls).toHaveLength(1);
    expect(store.redConTransaccion).toEqual([]);
    expect(store.transacciones).toBe(1);
    expect(store.abiertas).toBe(0);
  });

  it("mientras Meta tarda, la fila lleva el arrendamiento (no un media_id) y no hay ninguna transacción abierta", async () => {
    const cache = await cargar();
    let soltar!: () => void;
    const compuerta = new Promise<void>((ok) => (soltar = ok));
    let durante: { abiertas: number; id: unknown } | null = null;
    const lenta = async () => {
      durante = { abiertas: store.abiertas, id: store.rows[0]?.waMediaId };
      await compuerta;
      return "REAL-ID";
    };
    const p = cache.resolveWaMediaId(ITEM, CREDS, { upload: lenta as never, now: () => NOW });
    await vi.waitFor(() => expect(durante).not.toBeNull());
    expect(durante!.abiertas).toBe(0);
    expect(String(durante!.id)).toMatch(/^pending:/);
    expect(store.abiertas).toBe(0);
    soltar();
    expect(await p).toEqual({ waMediaId: "REAL-ID", reused: false });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.waMediaId).toBe("REAL-ID");
    expect(new Date(store.rows[0]!.expiresAt as Date).getTime()).toBe(NOW.getTime() + 25 * 86_400_000);
  });

  it("30 medios subiendo a la vez (más que el pool de 10): ninguna transacción retenida durante la red", async () => {
    const cache = await cargar();
    const up = uploader();
    const items = Array.from({ length: 30 }, (_, i) => ({ ...(ITEM as object), id: `med_${i}` }) as never);
    await Promise.all(items.map((it) => cache.resolveWaMediaId(it, CREDS, { upload: up.fn as never, now: () => NOW })));
    expect(up.calls).toHaveLength(30);
    expect(store.redConTransaccion).toEqual([]);
    expect(store.abiertas).toBe(0);
    expect(store.rows).toHaveLength(30);
  });

  it("entre instancias: con el arrendamiento de otra vigente se ESPERA (sin subir) y se reutiliza su id al terminar", async () => {
    const cache = await cargar();
    store.rows = [fila("pending:otra-instancia", { expiresAt: new Date(NOW.getTime() + 60_000) })];
    const up = uploader();
    const p = cache.resolveWaMediaId(ITEM, CREDS, { upload: up.fn as never, now: () => NOW, pollMs: 5 });
    await new Promise((r) => setTimeout(r, 40));
    expect(up.calls).toHaveLength(0);
    expect(store.abiertas).toBe(0);
    store.rows[0] = fila("ID-DE-LA-OTRA");
    expect(await p).toEqual({ waMediaId: "ID-DE-LA-OTRA", reused: true });
    expect(up.calls).toHaveLength(0);
  });

  it("un arrendamiento VENCIDO (la instancia que subía se cayó) se retoma: sube una vez", async () => {
    const cache = await cargar();
    store.rows = [fila("pending:muerta", { expiresAt: new Date(NOW.getTime() - 1) })];
    const up = uploader();
    const r = await cache.resolveWaMediaId(ITEM, CREDS, { upload: up.fn as never, now: () => NOW, pollMs: 5 });
    expect(r).toEqual({ waMediaId: "NEW-1", reused: false });
    expect(up.calls).toHaveLength(1);
    expect(store.rows[0]!.waMediaId).toBe("NEW-1");
  });

  it("un arrendamiento nunca se devuelve como media_id", async () => {
    const cache = await cargar();
    store.rows = [fila("pending:otra", { expiresAt: new Date(NOW.getTime() + 60_000) })];
    const up = uploader();
    const p = cache.resolveWaMediaId(ITEM, CREDS, { upload: up.fn as never, now: () => NOW, pollMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    store.rows[0] = fila("REAL");
    const r = await p;
    expect(r.waMediaId).toBe("REAL");
    expect(r.waMediaId.startsWith("pending:")).toBe(false);
  });

  it("si la subida a Meta falla, se suelta el arrendamiento (no bloquea a los demás) y el error se propaga", async () => {
    const cache = await cargar();
    const mala = async () => {
      throw new Error("Meta caído");
    };
    await expect(cache.resolveWaMediaId(ITEM, CREDS, { upload: mala as never, now: () => NOW })).rejects.toThrow("Meta caído");
    expect(store.rows).toHaveLength(0);
    const up = uploader();
    expect((await cache.resolveWaMediaId(ITEM, CREDS, { upload: up.fn as never, now: () => NOW })).waMediaId).toBe("NEW-1");
  });

  it("si el archivo ya no está en el almacenamiento: MediaArchivoAusente y arrendamiento suelto", async () => {
    const cache = await cargar();
    store.archivoAusente = true;
    const up = uploader();
    await expect(cache.resolveWaMediaId(ITEM, CREDS, { upload: up.fn as never, now: () => NOW })).rejects.toBeInstanceOf(cache.MediaArchivoAusente);
    expect(up.calls).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("si falla guardar el id real, se suelta el arrendamiento en vez de bloquear 2 minutos", async () => {
    const cache = await cargar();
    store.falloAlGuardar = true;
    const up = uploader();
    await expect(cache.resolveWaMediaId(ITEM, CREDS, { upload: up.fn as never, now: () => NOW })).rejects.toThrow("BD caída");
    expect(store.rows).toHaveLength(0);
  });

  it("liberar solo borra la fila si lleva el marcador PROPIO: el arrendamiento de otra instancia no se toca", async () => {
    const cache = await cargar();
    store.rows = [fila("pending:otro", { expiresAt: new Date(NOW.getTime() + 60_000) })];
    const mala = async () => {
      throw new Error("x");
    };
    const p = cache.resolveWaMediaId(ITEM, CREDS, { upload: mala as never, now: () => NOW, pollMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    expect(store.rows[0]!.waMediaId).toBe("pending:otro");
    store.rows[0] = fila("TERMINADO");
    expect((await p).waMediaId).toBe("TERMINADO");
  });
});
