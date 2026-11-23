import { beforeEach, describe, expect, it, vi } from "vitest";
import { NEEDS_COUNTRY_CODE } from "@/lib/ignored-number";

/**
 * Agente → Números ignorados: las rutas. Quién puede leer y quién escribir, que la organización salga SIEMPRE de la
 * sesión (nunca del cuerpo), y las respuestas de cada caso: alta individual, desde un contacto de la Bandeja,
 * «pegar varios», duplicado, tope y borrado. El aislamiento real entre organizaciones se prueba contra Postgres en
 * `ignored-api-live.test.ts`.
 */

const session = vi.hoisted(() => ({ role: "owner", organizationId: "org_a", userId: "usr_1" }));
vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ ...session }),
  getSessionOrNull: async () => ({ ...session }),
}));

const svc = vi.hoisted(() => ({
  listIgnored: vi.fn(),
  countIgnored: vi.fn(),
  addIgnored: vi.fn(),
  addIgnoredMany: vi.fn(),
  removeIgnored: vi.fn(),
  contactIdentityById: vi.fn(),
  findIgnoredForContact: vi.fn(),
}));
vi.mock("@/server/ai/ignored", () => svc);

const row = (over: Record<string, unknown> = {}) => ({
  id: "ign_1",
  organizationId: "org_a",
  channel: "whatsapp",
  key: "51987654321",
  label: "Mamá",
  createdAt: new Date("2026-11-23T10:00:00Z"),
  createdByUserId: "usr_1",
  ...over,
});

const json = (method: string, body?: unknown) =>
  new Request("https://x/api/agent/ignored-numbers", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const list = async (query = "") => {
  const { GET } = await import("@/app/api/agent/ignored-numbers/route");
  return GET(new Request(`https://x/api/agent/ignored-numbers${query}`));
};
const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/agent/ignored-numbers/route");
  return POST(json("POST", body));
};
const del = async (id: string) => {
  const { DELETE } = await import("@/app/api/agent/ignored-numbers/[id]/route");
  return DELETE(new Request(`https://x/api/agent/ignored-numbers/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
};

beforeEach(() => {
  session.role = "owner";
  session.organizationId = "org_a";
  for (const fn of Object.values(svc)) fn.mockReset();
  svc.listIgnored.mockResolvedValue([]);
  svc.countIgnored.mockResolvedValue(0);
});

describe("GET /api/agent/ignored-numbers", () => {
  it("devuelve la lista de la organización de la sesión, con el número en formato legible", async () => {
    svc.listIgnored.mockResolvedValue([row(), row({ id: "ign_2", channel: "instagram", key: "ig:178414", label: null })]);
    svc.countIgnored.mockResolvedValue(2);
    const res = await list();

    expect(res.status).toBe(200);
    expect(svc.listIgnored).toHaveBeenCalledWith("org_a", { channel: undefined, search: undefined });
    expect(await res.json()).toEqual({
      entries: [
        { id: "ign_1", channel: "whatsapp", key: "51987654321", display: "+51987654321", label: "Mamá", createdAt: "2026-11-23T10:00:00.000Z" },
        { id: "ign_2", channel: "instagram", key: "ig:178414", display: "ig:178414", label: null, createdAt: "2026-11-23T10:00:00.000Z" },
      ],
      total: 2,
      limit: 500,
    });
  });

  it("un miembro del equipo también puede leerla (la Bandeja lo necesita)", async () => {
    session.role = "member";
    expect((await list()).status).toBe(200);
  });

  it("pasa la búsqueda y el canal; un canal desconocido se ignora", async () => {
    await list("?search=mam%C3%A1&channel=instagram");
    expect(svc.listIgnored).toHaveBeenLastCalledWith("org_a", { channel: "instagram", search: "mamá" });
    await list("?channel=fax");
    expect(svc.listIgnored).toHaveBeenLastCalledWith("org_a", { channel: undefined, search: undefined });
  });
});

describe("GET /api/agent/ignored-numbers?contactId=", () => {
  const contact = { channel: "whatsapp", waIdentity: "51987654321", phone: "51987654321", waUserId: null };

  it("un contacto ignorado: `ignored: true` y la entrada, con el id para quitarla", async () => {
    svc.contactIdentityById.mockResolvedValue(contact);
    svc.findIgnoredForContact.mockResolvedValue(row());
    const res = await list("?contactId=ct_1");

    expect(res.status).toBe(200);
    expect(svc.contactIdentityById).toHaveBeenCalledWith("org_a", "ct_1");
    expect(svc.findIgnoredForContact).toHaveBeenCalledWith("org_a", contact);
    expect(await res.json()).toEqual({
      ignored: true,
      entry: { id: "ign_1", channel: "whatsapp", key: "51987654321", display: "+51987654321", label: "Mamá", createdAt: "2026-11-23T10:00:00.000Z" },
    });
    // Responde por ese contacto; no trae la lista entera.
    expect(svc.listIgnored).not.toHaveBeenCalled();
  });

  it("un contacto que no está en la lista: `ignored: false`", async () => {
    svc.contactIdentityById.mockResolvedValue(contact);
    svc.findIgnoredForContact.mockResolvedValue(null);
    expect(await (await list("?contactId=ct_1")).json()).toEqual({ ignored: false, entry: null });
  });

  it("lo puede consultar un miembro del equipo (la Bandeja enseña el estado a todos)", async () => {
    session.role = "member";
    svc.contactIdentityById.mockResolvedValue(contact);
    svc.findIgnoredForContact.mockResolvedValue(null);
    expect((await list("?contactId=ct_1")).status).toBe(200);
  });

  it("un contacto que no existe o es de otra organización: 404", async () => {
    svc.contactIdentityById.mockResolvedValue(null);
    expect((await list("?contactId=ct_ajeno")).status).toBe(404);
    expect(svc.findIgnoredForContact).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent/ignored-numbers", () => {
  it("un miembro del equipo no puede agregar: 403 y no toca nada", async () => {
    session.role = "member";
    const res = await post({ number: "+51 987 654 321" });
    expect(res.status).toBe(403);
    expect(svc.addIgnored).not.toHaveBeenCalled();
    expect(svc.addIgnoredMany).not.toHaveBeenCalled();
  });

  it("un administrador sí puede", async () => {
    session.role = "admin";
    svc.addIgnored.mockResolvedValue({ status: "added", entry: row() });
    expect((await post({ number: "+51 987 654 321" })).status).toBe(201);
  });

  it("alta individual: usa la organización y el usuario de la SESIÓN, aunque el cuerpo traiga otra", async () => {
    svc.addIgnored.mockResolvedValue({ status: "added", entry: row() });
    const res = await post({ number: "+51 987 654 321", label: "Mamá", organizationId: "org_b" });

    expect(res.status).toBe(201);
    expect(svc.addIgnored).toHaveBeenCalledWith("org_a", { raw: "+51 987 654 321", label: "Mamá" }, "usr_1");
    expect((await res.json()).entry).toMatchObject({ id: "ign_1", display: "+51987654321", label: "Mamá" });
  });

  it("desde un contacto de la Bandeja: busca su identidad en la organización de la sesión", async () => {
    const contact = { channel: "instagram", waIdentity: "ig:178414", phone: null, waUserId: null };
    svc.contactIdentityById.mockResolvedValue(contact);
    svc.addIgnored.mockResolvedValue({ status: "added", entry: row({ channel: "instagram", key: "ig:178414", label: null }) });
    const res = await post({ contactId: "ct_9" });

    expect(res.status).toBe(201);
    expect(svc.contactIdentityById).toHaveBeenCalledWith("org_a", "ct_9");
    expect(svc.addIgnored).toHaveBeenCalledWith("org_a", { contact, label: undefined }, "usr_1");
  });

  it("un contacto que no existe (o es de otra organización): 404", async () => {
    svc.contactIdentityById.mockResolvedValue(null);
    const res = await post({ contactId: "ct_ajeno" });
    expect(res.status).toBe(404);
    expect(svc.addIgnored).not.toHaveBeenCalled();
  });

  it("duplicado: 409 con un mensaje claro", async () => {
    svc.addIgnored.mockResolvedValue({ status: "duplicate" });
    const res = await post({ number: "+51 987 654 321" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "duplicate", message: "Ese número ya está en la lista." });
  });

  it("tope alcanzado: 409 con el límite", async () => {
    svc.addIgnored.mockResolvedValue({ status: "limit", limit: 500 });
    const res = await post({ number: "+51 987 654 321" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "limit_reached", limit: 500 });
  });

  it("sin código de país: 422 con el mensaje del servicio", async () => {
    svc.addIgnored.mockResolvedValue({ status: "invalid", error: NEEDS_COUNTRY_CODE });
    const res = await post({ number: "5512345678" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatchObject({ code: "invalid_number", message: "Incluye el código de país, por ejemplo +51…" });
  });

  it("pegar varios: un resumen con agregados, duplicados e inválidos con su línea y motivo", async () => {
    svc.addIgnoredMany.mockImplementation(async (_org: string, entries: { key: string; label: string | null; line: number }[]) => ({
      added: [row({ id: "ign_a", key: "51911111111", label: "Tienda" })],
      duplicates: entries.filter((e) => e.key === "51987654321"),
      overLimit: [],
    }));
    const res = await post({ bulk: ["+51 987 654 321", "+51 911 111 111, Tienda", "5512345678", "Mamá"].join("\n") });

    expect(res.status).toBe(200);
    const out = await res.json();
    expect(svc.addIgnoredMany).toHaveBeenCalledWith(
      "org_a",
      [
        { line: 1, key: "51987654321", label: null },
        { line: 2, key: "51911111111", label: "Tienda" },
      ],
      "usr_1"
    );
    expect(out.added).toHaveLength(1);
    expect(out.duplicates).toEqual([{ line: 1, key: "51987654321", label: null }]);
    expect(out.invalid).toEqual([
      { line: 3, text: "5512345678", reason: NEEDS_COUNTRY_CODE },
      { line: 4, text: "Mamá", reason: "No parece un número de teléfono." },
    ]);
    expect(out.overLimit).toEqual([]);
    expect(out.limit).toBe(500);
  });

  it("pegar varios cuando no cabe todo: lo que pasa del tope vuelve en `overLimit`", async () => {
    svc.addIgnoredMany.mockImplementation(async (_org: string, entries: unknown[]) => ({ added: [], duplicates: [], overLimit: entries }));
    const res = await post({ bulk: "+51 987 654 321" });
    expect((await res.json()).overLimit).toHaveLength(1);
  });

  it("exige exactamente una forma de agregar", async () => {
    expect((await post({})).status).toBe(422);
    expect((await post({ number: "+51 987 654 321", bulk: "+51 911 111 111" })).status).toBe(422);
    expect((await post({ number: "+51 987 654 321", contactId: "ct_1" })).status).toBe(422);
    expect((await post({ label: "solo nota" })).status).toBe(422);
    expect(svc.addIgnored).not.toHaveBeenCalled();
    expect(svc.addIgnoredMany).not.toHaveBeenCalled();
  });

  it("un texto pegado desmesurado se rechaza sin procesarlo", async () => {
    const res = await post({ bulk: "1".repeat(60_001) });
    expect(res.status).toBe(422);
    expect(svc.addIgnoredMany).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/agent/ignored-numbers/[id]", () => {
  it("un miembro del equipo no puede quitar: 403", async () => {
    session.role = "member";
    const res = await del("ign_1");
    expect(res.status).toBe(403);
    expect(svc.removeIgnored).not.toHaveBeenCalled();
  });

  it("quita la entrada de la organización de la sesión", async () => {
    svc.removeIgnored.mockResolvedValue(true);
    const res = await del("ign_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(svc.removeIgnored).toHaveBeenCalledWith("org_a", "ign_1");
  });

  it("una entrada que no existe o es de otra organización: 404", async () => {
    svc.removeIgnored.mockResolvedValue(false);
    const res = await del("ign_ajena");
    expect(res.status).toBe(404);
  });
});
