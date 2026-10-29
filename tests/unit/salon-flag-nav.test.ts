import { afterEach, describe, expect, it } from "vitest";
import { appNavGroups } from "@/lib/nav";
import { parseSalonFlag, salonDisabledResponse, salonEnabled } from "@/server/business/flag";
import { salonGate } from "@/server/business/http";

/**
 * Módulo SALON — apagado por defecto (ADR-001): sin la bandera no existe ni en
 * el menú ni en la API, y con ella el dinero es solo del dueño o administrador.
 */

const session = (role: string) => ({ userId: "u", organizationId: "org_1", role });

describe("bandera SALON", () => {
  const original = process.env.SALON;
  afterEach(() => {
    if (original === undefined) delete process.env.SALON;
    else process.env.SALON = original;
  });

  it("los mismos valores de «encendida» que AGENDA; todo lo demás, apagada", () => {
    for (const v of ["on", "ON", "1", "true", "si", "sí", "yes", " on "]) {
      expect(parseSalonFlag(v)).toBe(true);
    }
    for (const v of ["", "off", "0", "false", "no", "talvez", undefined]) {
      expect(parseSalonFlag(v)).toBe(false);
    }
  });

  it("sin la variable está apagada", () => {
    delete process.env.SALON;
    expect(salonEnabled()).toBe(false);
  });

  it("apagada, la superficie responde 404 (no 403) y cualquier rol", () => {
    delete process.env.SALON;
    expect(salonDisabledResponse().status).toBe(404);
    expect(salonGate(session("owner"), "member")?.status).toBe(404);
    expect(salonGate(session("owner"), "manager")?.status).toBe(404);
  });

  it("encendida: el equipo (member) pasa lo operativo y no lo que mueve dinero", () => {
    process.env.SALON = "on";
    expect(salonGate(session("member"), "member")).toBeNull();
    expect(salonGate(session("member"), "manager")?.status).toBe(403);
    expect(salonGate(session("owner"), "manager")).toBeNull();
    expect(salonGate(session("admin"), "manager")).toBeNull();
  });
});

describe("menú", () => {
  const hrefs = (o: Parameters<typeof appNavGroups>[0]) =>
    appNavGroups(o).flatMap((g) => g.items.map((i) => i.href));

  const TRES = ["/panel", "/servicios", "/equipo", "/caja", "/gastos", "/clientes"];

  it("sin la bandera no hay Servicios, Equipo ni Caja para nadie", () => {
    for (const o of [{ role: "owner" }, { role: "owner", agenda: true }]) {
      for (const h of TRES) expect(hrefs(o)).not.toContain(h);
    }
  });

  it("con la bandera, dueño y administrador ven el menú de trabajo en su orden", () => {
    for (const role of ["owner", "admin"]) {
      const g = appNavGroups({ salon: true, agenda: true, role })[0]!;
      expect(g.items.map((i) => i.href)).toEqual([
        "/panel",
        "/caja",
        "/gastos",
        "/citas",
        "/clientes",
        "/contactos",
        "/servicios",
        "/equipo",
        "/medios",
        "/notificaciones",
      ]);
    }
  });

  it("la agenda por sillas ya no es un ítem aparte: vive dentro de Citas", () => {
    for (const role of ["owner", "admin", "member"]) {
      expect(hrefs({ salon: true, agenda: true, role })).not.toContain("/agenda-por-sillas");
    }
    expect(hrefs({ salon: true, agenda: true, role: "owner" }).filter((h) => h === "/citas")).toHaveLength(1);
  });

  it("sin agenda, dueño y administrador siguen viendo Servicios, Equipo y Caja", () => {
    expect(hrefs({ salon: true, role: "owner" })).toEqual(expect.arrayContaining(TRES));
  });

  it("un miembro del equipo no ve Servicios, Equipo ni Caja; con agenda, ve Citas", () => {
    for (const o of [{ salon: true, role: "member" }, { salon: true, role: "member", agenda: true }]) {
      for (const h of TRES) expect(hrefs(o)).not.toContain(h);
    }
    expect(hrefs({ salon: true, role: "member", agenda: true })).toContain("/citas");
  });

  it("no altera el resto del menú", () => {
    const sin = hrefs({ role: "owner", agenda: true });
    const con = hrefs({ salon: true, role: "owner", agenda: true }).filter((h) => !TRES.includes(h));
    expect(con).toEqual(sin);
  });
});
