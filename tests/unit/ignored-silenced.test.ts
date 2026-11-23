import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Números ignorados — `isConversationSilenced`, lo que llama el flujo del agente. Nunca lanza, y ante un fallo de la
 * base de datos dice «callar»: responderle a un número que el dueño pidió ignorar es peor que perder un turno.
 */

// BD simulada: cola de resultados de select (conversación→contacto, luego la lista) o un fallo.
const selectQueue: unknown[][] = [];
let failWith: Error | null = null;
const wheres: unknown[] = [];

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.innerJoin = () => chain;
  chain.where = (w: unknown) => {
    wheres.push(w);
    return chain;
  };
  chain.limit = () => chain;
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    failWith ? Promise.reject(failWith).then(resolve, reject) : Promise.resolve(rows).then(resolve, reject);
  return chain;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({ select: () => thenableChain(selectQueue.shift() ?? []) }),
  schema: new Proxy(
    {},
    { get: (_t, table) => new Proxy({}, { get: (_t2, col) => `${String(table)}.${String(col)}` }) }
  ),
}));

let isConversationSilenced: (organizationId: string, conversationId: string) => Promise<boolean>;

describe("números ignorados: isConversationSilenced", () => {
  beforeEach(async () => {
    selectQueue.length = 0;
    wheres.length = 0;
    failWith = null;
    ({ isConversationSilenced } = await import("@/server/ai/ignored"));
  });

  it("el contacto está en la lista: calla", async () => {
    selectQueue.push([{ channel: "whatsapp", waIdentity: "525512345678", phone: "525512345678", waUserId: null }], [{ id: "ign_1" }]);
    expect(await isConversationSilenced("org_1", "cv_1")).toBe(true);
  });

  it("el contacto NO está en la lista: no calla", async () => {
    selectQueue.push([{ channel: "whatsapp", waIdentity: "525512345678", phone: "525512345678", waUserId: null }], []);
    expect(await isConversationSilenced("org_1", "cv_1")).toBe(false);
  });

  it("una conversación que no existe: no calla (el turno ya se las arregla con eso)", async () => {
    selectQueue.push([]);
    expect(await isConversationSilenced("org_1", "cv_x")).toBe(false);
  });

  it("si la base falla: calla, lo registra y NO lanza", async () => {
    failWith = new Error("conexión caída");
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(isConversationSilenced("org_1", "cv_1")).resolves.toBe(true);
    expect(consola).toHaveBeenCalledTimes(1);
    expect(String(consola.mock.calls[0]![0])).toContain("cv_1");
    consola.mockRestore();
  });

  it("contacto de un canal sin teléfono (Instagram): consulta con su identidad", async () => {
    selectQueue.push([{ channel: "instagram", waIdentity: "ig:178414", phone: null, waUserId: null }], [{ id: "ign_2" }]);
    expect(await isConversationSilenced("org_1", "cv_2")).toBe(true);
    // Dos consultas: la identidad de la conversación y la lista.
    expect(wheres).toHaveLength(2);
  });
});
