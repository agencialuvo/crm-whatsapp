import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Paso 2, anti-bucle de `tag_added` (sin base de datos real: el acceso a Postgres es un doble). Va en su propio
 * archivo porque aquí `onTagAdded` es un espía: en `automation-step2.test.ts` se prueba el real.
 */

/* ─── assignTag: avisa solo si la asignación es nueva y no viene de una automatización ─── */

const emitted = vi.hoisted(() => ({ onTagAdded: vi.fn(async () => 0) }));
const dbState = vi.hoisted(() => ({ insertRows: [] as { tagId: string; assignedAt: Date }[] }));

vi.mock("@/server/automation/triggers", async (orig) => ({ ...(await orig<typeof import("@/server/automation/triggers")>()), onTagAdded: emitted.onTagAdded }));
vi.mock("@/lib/db", async (orig) => {
  const real = await orig<typeof import("@/lib/db")>();
  // Toda consulta encuentra «algo» (la etiqueta y el contacto existen); el insert devuelve lo que fije cada prueba.
  const chain = (result: () => unknown): unknown =>
    new Proxy(function () {}, {
      get: (_t, p) => (p === "then" ? (res: (v: unknown) => unknown) => res(result()) : () => chain(result)),
      apply: () => chain(result),
    });
  return {
    ...real,
    getDb: () => ({
      select: () => chain(() => [{ id: "x", name: "VIP", color: "slate" }]),
      insert: () => chain(() => dbState.insertRows),
    }),
  };
});

describe("assignTag y tag_added (anti-bucle)", () => {
  const at = new Date("2026-03-15T10:00:00.000Z");
  beforeEach(() => {
    emitted.onTagAdded.mockClear();
    dbState.insertRows = [{ tagId: "tag_1", assignedAt: at }];
  });

  it("una asignación nueva avisa a las automatizaciones, con la hora de la asignación", async () => {
    const { assignTag } = await import("@/server/tags/store");
    expect(await assignTag("org_1", "ct_1", "tag_1")).toBe(true);
    expect(emitted.onTagAdded).toHaveBeenCalledWith({ organizationId: "org_1", contactId: "ct_1", tagId: "tag_1", assignedAt: at });
  });
  it("si ya la tenía no hay asignación nueva y no avisa", async () => {
    dbState.insertRows = [];
    const { assignTag } = await import("@/server/tags/store");
    expect(await assignTag("org_1", "ct_1", "tag_1")).toBe(false);
    expect(emitted.onTagAdded).not.toHaveBeenCalled();
  });
  it("viaAutomation (el paso add_tag del motor) asigna pero NO avisa: un flujo no dispara otro", async () => {
    const { assignTag } = await import("@/server/tags/store");
    expect(await assignTag("org_1", "ct_1", "tag_1", { viaAutomation: true })).toBe(true);
    expect(emitted.onTagAdded).not.toHaveBeenCalled();
  });
  it("el paso add_tag del motor pasa viaAutomation (lo que cablea applyTag)", async () => {
    const store = await import("@/server/tags/store");
    const spy = vi.spyOn(store, "assignTag");
    const { applyTag } = await import("@/server/automation/actions");
    await applyTag("org_1", "ct_1", "tag_1", "add");
    expect(spy).toHaveBeenCalledWith("org_1", "ct_1", "tag_1", { viaAutomation: true });
    spy.mockRestore();
  });
});
