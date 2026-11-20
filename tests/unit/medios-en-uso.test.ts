import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hallazgo E — borrar un medio de la biblioteca se bloquea si algo lo usa: pasos de automatización, y servicios, ofertas,
 * equipo y fidelidad (logo / icono de sellos), que de otro modo quedarían sin imagen en silencio. Sin base real: una base
 * en memoria que entiende los `eq`/`and`/`or` y la proyección de columnas de lo que consulta el módulo.
 */

type Fila = Record<string, unknown>;
type Cond = { op: string; col?: string; val?: unknown; args?: Cond[]; cfg?: unknown };

const hoisted = vi.hoisted(() => ({ tablas: {} as Record<string, Fila[]>, MEDIA_DIR: { v: "" } }));

vi.mock("drizzle-orm", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...original,
    eq: (col: string, val: unknown) => ({ op: "eq", col, val }),
    and: (...args: unknown[]) => ({ op: "and", args: args.filter((a) => a !== undefined) }),
    or: (...args: unknown[]) => ({ op: "or", args: args.filter((a) => a !== undefined) }),
    // sql`${step.config}->>'mediaId' = ${id}` → se evalúa como config.mediaId === id
    sql: (_s: TemplateStringsArray, ...v: unknown[]) => ({ op: "cfg", cfg: v[1] }),
    desc: (c: string) => c,
    lt: (col: string, val: unknown) => ({ op: "lt", col, val }),
  };
});

vi.mock("@/lib/db", () => {
  const col = (t: string, cols: string[]) => ({ __t: t, ...Object.fromEntries(cols.map((c) => [c, `${t}.${c}`])) });
  return {
  getDb: () => db,
  schema: {
    mediaLibraryItem: col("mediaLibraryItem", ["id", "organizationId", "name", "status", "kind", "createdAt"]),
    service: col("service", ["id", "organizationId", "name", "imageMediaId"]),
    combo: col("combo", ["id", "organizationId", "name", "imageMediaId"]),
    staff: col("staff", ["id", "organizationId", "name", "imageMediaId"]),
    loyaltySettings: col("loyaltySettings", ["id", "organizationId", "cardTitle", "logoMediaId", "stampIconMediaId"]),
    automationStep: col("automationStep", ["id", "organizationId", "flowId", "stepType", "config"]),
    automationFlow: col("automationFlow", ["id", "name"]),
    whatsappMediaCache: col("whatsappMediaCache", ["id", "mediaItemId"]),
  },
  };
});
vi.mock("@/lib/db/tenant", () => ({
  scoped: (c: string, org: string, ...conds: Cond[]) => ({ op: "and", args: [{ op: "eq", col: c, val: org }, ...conds.filter(Boolean)] }),
}));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ MEDIA_DIR: hoisted.MEDIA_DIR.v }) }));

const campo = (c: string) => c.split(".")[1]!;
const coincide = (w: Cond, r: Fila): boolean => {
  if (w.op === "and") return (w.args ?? []).every((a) => coincide(a, r));
  if (w.op === "or") return (w.args ?? []).some((a) => coincide(a, r));
  if (w.op === "eq") return r[campo(w.col!)] === w.val;
  if (w.op === "cfg") return (r.config as { mediaId?: string } | undefined)?.mediaId === w.cfg;
  return true;
};
const proyectar = (shape: Record<string, string> | undefined, r: Fila): Fila =>
  shape ? Object.fromEntries(Object.entries(shape).map(([k, c]) => [k, r[campo(c)]])) : r;

const db = {
  select: (shape?: Record<string, string>) => ({
    from: (t: { __t: string }) => ({
      where: (w: Cond) => {
        const filas = hoisted.tablas[t.__t]!.filter((r) => coincide(w, r)).map((r) => proyectar(shape, r));
        return Object.assign(Promise.resolve(filas), { orderBy: async () => filas, limit: async (n: number) => filas.slice(0, n) });
      },
    }),
  }),
  selectDistinct: () => ({
    from: (t: { __t: string }) => ({
      innerJoin: () => ({
        where: async (w: Cond) => {
          const pasos = hoisted.tablas[t.__t]!.filter((r) => coincide(w, r));
          const vistos = new Map<string, Fila>();
          for (const p of pasos) {
            const flujo = hoisted.tablas.automationFlow!.find((f) => f.id === p.flowId);
            if (flujo) vistos.set(flujo.id as string, { id: flujo.id, name: flujo.name });
          }
          return [...vistos.values()];
        },
      }),
    }),
  }),
  delete: (t: { __t: string }) => ({
    where: async (w: Cond) => {
      hoisted.tablas[t.__t] = hoisted.tablas[t.__t]!.filter((r) => !coincide(w, r));
    },
  }),
};

import { AVISO_ENLACES_PEGADOS, borrarMedio, borrarMedios, mensajeDeUsos, usosDeMedio } from "@/server/medios/store";

const ORG = "org_1";
const OTRA = "org_2";
const M = "med_aaaaaaaaaaaaaaaaaaaa";
const M2 = "med_bbbbbbbbbbbbbbbbbbbb";
const quien = { userId: "usr_1", puedeAdministrar: true };

function medio(id: string, organizationId = ORG, name = "Foto del local"): Fila {
  return { id, organizationId, name, kind: "image", mimeType: "image/png", sizeBytes: 100, storage: "local", storageKey: null, status: "ready", createdBy: "usr_1" };
}
const intentar = (id = M, org = ORG) => borrarMedio({ organizationId: org, ...quien, id });
const ids = () => hoisted.tablas.mediaLibraryItem!.map((m) => m.id);

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "vocero-medios-"));
  hoisted.MEDIA_DIR.v = tmp;
  hoisted.tablas = {
    mediaLibraryItem: [medio(M), medio(M2, ORG, "Otro"), medio("med_cccccccccccccccccccc", OTRA, "Ajeno")],
    service: [],
    combo: [],
    staff: [],
    loyaltySettings: [],
    automationStep: [],
    automationFlow: [],
    whatsappMediaCache: [],
  };
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function bloqueado(code = "in_use") {
  const err = await intentar().then(() => null, (e) => e);
  expect(err).toMatchObject({ name: "MedioError", code });
  expect(ids()).toContain(M); // no se borró
  return err as { message: string; usos: { tipo: string; id: string; nombre: string; detalle?: string }[] };
}

describe("el medio está en uso → no se borra", () => {
  it("en un servicio", async () => {
    hoisted.tablas.service = [{ id: "srv_1", organizationId: ORG, name: "Corte clásico", imageMediaId: M }];
    const e = await bloqueado();
    expect(e.usos).toEqual([{ tipo: "servicio", id: "srv_1", nombre: "Corte clásico" }]);
    expect(e.message).toContain("el servicio «Corte clásico»");
    expect(e.message).toContain("«Foto del local»");
  });

  it("en una oferta (combo)", async () => {
    hoisted.tablas.combo = [{ id: "cmb_1", organizationId: ORG, name: "Combo Fresh", imageMediaId: M }];
    const e = await bloqueado();
    expect(e.usos).toEqual([{ tipo: "combo", id: "cmb_1", nombre: "Combo Fresh" }]);
    expect(e.message).toContain("la oferta «Combo Fresh»");
  });

  it("en el personal", async () => {
    hoisted.tablas.staff = [{ id: "stf_1", organizationId: ORG, name: "Ana", imageMediaId: M }];
    const e = await bloqueado();
    expect(e.usos).toEqual([{ tipo: "personal", id: "stf_1", nombre: "Ana" }]);
    expect(e.message).toContain("el integrante del equipo «Ana»");
  });

  it("en el logo de la tarjeta de fidelidad", async () => {
    hoisted.tablas.loyaltySettings = [{ id: "lgs_1", organizationId: ORG, cardTitle: "Tarjeta VIP", logoMediaId: M, stampIconMediaId: null }];
    const e = await bloqueado();
    expect(e.usos).toEqual([{ tipo: "fidelidad", id: "lgs_1", nombre: "Tarjeta VIP", detalle: "logo" }]);
    expect(e.message).toContain("la tarjeta de fidelidad «Tarjeta VIP» (logo)");
  });

  it("en el icono de los sellos de fidelidad", async () => {
    hoisted.tablas.loyaltySettings = [{ id: "lgs_1", organizationId: ORG, cardTitle: "Tarjeta VIP", logoMediaId: null, stampIconMediaId: M }];
    const e = await bloqueado();
    expect(e.usos).toEqual([{ tipo: "fidelidad", id: "lgs_1", nombre: "Tarjeta VIP", detalle: "icono de los sellos" }]);
  });

  it("como logo Y como icono a la vez: dos usos de la misma tarjeta", async () => {
    hoisted.tablas.loyaltySettings = [{ id: "lgs_1", organizationId: ORG, cardTitle: "Tarjeta VIP", logoMediaId: M, stampIconMediaId: M }];
    const e = await bloqueado();
    expect(e.usos.map((u) => u.detalle)).toEqual(["logo", "icono de los sellos"]);
  });

  it("en un paso de automatización (como antes) y el mensaje pide cambiar ese paso", async () => {
    hoisted.tablas.automationFlow = [{ id: "flw_1", name: "Bienvenida" }];
    hoisted.tablas.automationStep = [{ id: "stp_1", organizationId: ORG, flowId: "flw_1", stepType: "send_media", config: { mediaId: M } }];
    const e = await bloqueado();
    expect(e.usos).toEqual([{ tipo: "automatizacion", id: "flw_1", nombre: "Bienvenida" }]);
    expect(e.message).toContain("la automatización «Bienvenida»");
    expect(e.message).toContain("ese paso");
  });

  it("en varios sitios a la vez: los lista todos, agrupados", async () => {
    hoisted.tablas.service = [
      { id: "srv_1", organizationId: ORG, name: "Corte", imageMediaId: M },
      { id: "srv_2", organizationId: ORG, name: "Barba", imageMediaId: M },
    ];
    hoisted.tablas.staff = [{ id: "stf_1", organizationId: ORG, name: "Ana", imageMediaId: M }];
    hoisted.tablas.loyaltySettings = [{ id: "lgs_1", organizationId: ORG, cardTitle: "VIP", logoMediaId: M, stampIconMediaId: null }];
    const e = await bloqueado();
    expect(e.usos.map((u) => u.tipo)).toEqual(["servicio", "servicio", "personal", "fidelidad"]);
    expect(e.message).toContain("los servicios «Corte», «Barba»");
    expect(e.message).toContain("el integrante del equipo «Ana»");
    expect(e.message).toContain("la tarjeta de fidelidad «VIP» (logo)");
  });

  it("un uso en OTRA organización no bloquea, y un uso de otro medio tampoco", async () => {
    hoisted.tablas.service = [
      { id: "srv_x", organizationId: OTRA, name: "Ajeno", imageMediaId: M },
      { id: "srv_y", organizationId: ORG, name: "Con otra imagen", imageMediaId: M2 },
    ];
    expect(await usosDeMedio(ORG, M)).toEqual([]);
    await intentar();
    expect(ids()).not.toContain(M);
  });
});

describe("sin usos → se borra", () => {
  it("un medio libre se borra y los demás se quedan", async () => {
    await intentar();
    expect(ids()).toEqual([M2, "med_cccccccccccccccccccc"]);
  });

  it("tras quitar el uso, ya se puede borrar", async () => {
    hoisted.tablas.staff = [{ id: "stf_1", organizationId: ORG, name: "Ana", imageMediaId: M }];
    await bloqueado();
    hoisted.tablas.staff = [{ id: "stf_1", organizationId: ORG, name: "Ana", imageMediaId: null }];
    await intentar();
    expect(ids()).not.toContain(M);
  });

  it("un id de otra organización sigue respondiendo not_found", async () => {
    await expect(intentar("med_cccccccccccccccccccc", ORG)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("borrar varios (la pantalla usa este camino)", () => {
  it("los que están en uso vuelven en `omitidos` con motivo y usos; los libres se borran; incluye el aviso de enlaces", async () => {
    hoisted.tablas.combo = [{ id: "cmb_1", organizationId: ORG, name: "Combo Fresh", imageMediaId: M }];
    const r = await borrarMedios({ organizationId: ORG, ...quien, ids: [M, M2] });
    expect(r.borrados).toEqual([M2]);
    expect(r.omitidos).toHaveLength(1);
    expect(r.omitidos[0]).toMatchObject({ id: M, usos: [{ tipo: "combo", nombre: "Combo Fresh" }] });
    expect(r.omitidos[0]!.motivo).toContain("la oferta «Combo Fresh»"); // la pantalla muestra `motivo`, como siempre
    expect(r.aviso).toBe(AVISO_ENLACES_PEGADOS);
    expect(r.aviso).toContain("Copiar URL");
  });
});

describe("mensajeDeUsos", () => {
  it("sin automatizaciones, pide cambiarlo o quitarlo de ahí", () => {
    expect(mensajeDeUsos("Logo", [{ tipo: "servicio", id: "s", nombre: "Corte" }])).toBe(
      "«Logo» está en uso en el servicio «Corte». Cámbialo o quítalo de ahí antes de borrarlo."
    );
  });
});

describe("DELETE /api/medios/:id", { timeout: 30_000 }, () => {
  async function ruta() {
    vi.resetModules();
    vi.doMock("@/lib/api", async (importOriginal) => {
      const original = await importOriginal<typeof import("@/lib/api")>();
      return { ...original, withAuth: (h: (...a: unknown[]) => Promise<Response>) => (...args: unknown[]) => h({ organizationId: ORG, userId: "usr_1", role: "owner" }, ...args) };
    });
    return import("@/app/api/medios/[id]/route");
  }
  const llamar = async (id: string) => {
    const { DELETE } = await ruta();
    return (DELETE as unknown as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>)(new Request("http://x"), { params: Promise.resolve({ id }) });
  };

  it("en uso → 409 in_use con `error.usos` (y code/message de siempre)", async () => {
    hoisted.tablas.service = [{ id: "srv_1", organizationId: ORG, name: "Corte", imageMediaId: M }];
    const res = await llamar(M);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("in_use");
    expect(body.error.message).toContain("el servicio «Corte»");
    expect(body.error.usos).toEqual([{ tipo: "servicio", id: "srv_1", nombre: "Corte" }]);
  });

  it("libre → 200 { ok: true } más el aviso de enlaces pegados", async () => {
    const res = await llamar(M);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, aviso: AVISO_ENLACES_PEGADOS });
  });
});
