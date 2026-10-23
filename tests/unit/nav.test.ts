import { describe, expect, it } from "vitest";
import {
  appNavGroups,
  isNavActive,
  NAV_V2,
  salonHomePath,
  SETTINGS_ITEM,
  settingsSections,
  SYSTEM_TITLE,
} from "@/lib/nav";

/**
 * #87 — El menú agrupado y Ajustes en tres secciones. Lo que aparece y lo
 * que no lo deciden las banderas (`AGENDA`, `CHANNELS`, `ATRIBUCION`) y el
 * rol; aquí se afirma sobre el modelo, sin dibujar nada.
 */

const labels = (groups: { items: { label: string }[] }[]) =>
  groups.map((g) => g.items.map((i) => i.label));

describe("barra lateral agrupada (v1.0)", () => {
  it("con todo apagado y como miembro: solo Trabajo, con Contactos, Medios y Notificaciones", () => {
    const groups = appNavGroups({ role: "member" });
    expect(groups.map((g) => g.title)).toEqual(["Trabajo"]);
    expect(labels(groups)).toEqual([["Contactos", "Medios", "Notificaciones"]]);
  });

  it("AGENDA añade Citas en su lugar: antes de Contactos", () => {
    const [trabajo] = appNavGroups({ agenda: true, role: "member" });
    expect(trabajo!.items.map((i) => i.label)).toEqual(["Citas", "Contactos", "Medios", "Notificaciones"]);
  });

  it("la v1.0 oculta Bandeja, Pipeline y todo el bloque Agente; las rutas siguen existiendo", () => {
    expect(NAV_V2).toBe(false);
    for (const role of ["owner", "admin", "member", null]) {
      const hrefs = appNavGroups({ salon: true, agenda: true, role }).flatMap((g) =>
        g.items.map((i) => i.href)
      );
      for (const h of ["/bandeja", "/pipeline", "/guia-de-inicio", "/agente", "/laboratorio", "/resultados"]) {
        expect(hrefs, `${role} ${h}`).not.toContain(h);
      }
    }
  });

  it("Ajustes queda fuera de los grupos, bajo el encabezado Sistema, y cada entrada trae icono", () => {
    const todos = appNavGroups({ salon: true, agenda: true, role: "owner" }).flatMap((g) => g.items);
    expect(todos.map((i) => i.href)).not.toContain("/ajustes");
    expect(SETTINGS_ITEM.href).toBe("/ajustes");
    expect(SYSTEM_TITLE).toBe("Sistema");
    for (const item of [...todos, SETTINGS_ITEM]) expect(item.icon).toBeDefined();
  });

  it("una ruta hija activa su entrada, y /ajustes no activa nada más", () => {
    expect(isNavActive("/bandeja/cv_123", "/bandeja")).toBe(true);
    expect(isNavActive("/bandeja", "/bandeja")).toBe(true);
    expect(isNavActive("/inboxes", "/bandeja")).toBe(false);
    expect(isNavActive("/ajustes/ia", "/ajustes")).toBe(true);
    expect(isNavActive("/ajustes/ia", "/agente")).toBe(false);
  });
});

describe("entrada con SALON encendido", () => {
  it("dueño y administrador entran al Panel, que es una entrada visible del menú", () => {
    for (const role of ["owner", "admin"]) {
      const home = salonHomePath({ agenda: true, role });
      expect(home).toBe("/panel");
      const hrefs = appNavGroups({ salon: true, agenda: true, role }).flatMap((g) =>
        g.items.map((i) => i.href)
      );
      expect(hrefs).toContain(home);
      expect(isNavActive("/panel", home)).toBe(true);
    }
  });

  it("un miembro del equipo, sin Panel, entra a Citas o a Contactos (siempre en su menú)", () => {
    for (const agenda of [true, false]) {
      const home = salonHomePath({ agenda, role: "member" });
      expect(home).toBe(agenda ? "/citas" : "/contactos");
      const hrefs = appNavGroups({ salon: true, agenda, role: "member" }).flatMap((g) =>
        g.items.map((i) => i.href)
      );
      expect(hrefs).toContain(home);
    }
  });
});

describe("ajustes en tres secciones", () => {
  const links = (s: { title: string; links: { label: string }[] }[]) =>
    Object.fromEntries(s.map((x) => [x.title, x.links.map((l) => l.label)]));

  it("con todo apagado: Canales, Agente y Negocio con lo mínimo", () => {
    const sections = settingsSections({});
    expect(sections.map((s) => s.title)).toEqual(["Canales", "Agente", "Negocio"]);
    expect(links(sections)).toEqual({
      Canales: ["WhatsApp"],
      Agente: ["IA"],
      Negocio: ["Marca", "Plantillas", "Equipo"],
    });
  });

  it("cada bandera añade su enlace en su sección y en ninguna otra", () => {
    // 023: con un canal social, "Estado" abre la sección.
    expect(links(settingsSections({ messenger: true }))).toEqual({
      Canales: ["Estado", "WhatsApp", "Messenger"],
      Agente: ["IA"],
      Negocio: ["Marca", "Plantillas", "Equipo"],
    });
    expect(links(settingsSections({ instagram: true })).Canales).toEqual([
      "Estado",
      "WhatsApp",
      "Instagram",
    ]);
    expect(
      links(settingsSections({ instagram: true, messenger: true, tiktok: true })).Canales
    ).toEqual(["Estado", "WhatsApp", "Instagram", "Messenger", "TikTok"]);
    expect(links(settingsSections({ agenda: true }))).toEqual({
      Canales: ["WhatsApp"],
      Agente: ["IA", "Agenda"],
      Negocio: ["Marca", "Plantillas", "Equipo"],
    });
    expect(links(settingsSections({ atribucion: true }))).toEqual({
      Canales: ["WhatsApp"],
      Agente: ["IA"],
      Negocio: ["Marca", "Plantillas", "Equipo", "Anuncios"],
    });
  });

  it("con todo encendido, cada pantalla de Ajustes tiene exactamente un enlace", () => {
    const all = settingsSections({
      agenda: true,
      atribucion: true,
      instagram: true,
      messenger: true,
      tiktok: true,
    })
      .flatMap((s) => s.links)
      .map((l) => l.href);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(
      [
        "/ajustes/canales",
        "/ajustes/whatsapp",
        "/ajustes/instagram",
        "/ajustes/messenger",
        "/ajustes/tiktok",
        "/ajustes/ia",
        "/ajustes/calendario",
        "/ajustes/marca",
        "/ajustes/plantillas",
        "/ajustes/equipo",
        "/ajustes/anuncios",
      ].sort()
    );
  });

  it("el Laboratorio no está en Ajustes (ni en el menú de la v1.0)", () => {
    const hrefs = settingsSections({ agenda: true, atribucion: true, messenger: true })
      .flatMap((s) => s.links)
      .map((l) => l.href);
    expect(hrefs).not.toContain("/laboratorio");
  });
});
