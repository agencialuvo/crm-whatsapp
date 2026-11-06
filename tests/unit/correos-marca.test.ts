import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- La marca de quien recibe: lo que devuelve la consulta de membresía (negocio + metadata).
let rows: { metadata: string | null }[] = [];
vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  for (const k of ["from", "innerJoin", "where", "orderBy"]) chain[k] = () => chain;
  chain.limit = async () => rows;
  return {
    getDb: () => ({ select: () => chain }),
    schema: {
      member: { organizationId: "m.org", userId: "m.user", createdAt: "m.created" },
      organization: { id: "o.id", metadata: "o.meta" },
      user: { id: "u.id", email: "u.email" },
    },
  };
});

import { buildFrom, cleanSenderName, senderAddress } from "@/server/email/mailer";
import { DEFAULT_BRANDING } from "@/lib/branding";
import { getBrandingForUser } from "@/server/branding";

describe("el remitente lleva el nombre de la marca", () => {
  it("saca la dirección de «Nombre <correo>» y de un correo suelto", () => {
    expect(senderAddress("Agencia Luvo <soporte@luvo.test>")).toBe("soporte@luvo.test");
    expect(senderAddress("soporte@luvo.test")).toBe("soporte@luvo.test");
    expect(senderAddress('"Con, coma" <a@b.test> ')).toBe("a@b.test");
  });

  it("con nombre de marca: el nombre cambia y la dirección de la instancia se queda", () => {
    expect(buildFrom("Agencia Luvo <soporte@luvo.test>", "Studio Mary")).toEqual({
      name: "Studio Mary",
      address: "soporte@luvo.test",
    });
  });

  it("sin nombre (o vacío) se respeta el remitente configurado tal cual", () => {
    expect(buildFrom("Agencia Luvo <soporte@luvo.test>")).toBe("Agencia Luvo <soporte@luvo.test>");
    expect(buildFrom("Agencia Luvo <soporte@luvo.test>", "  ")).toBe("Agencia Luvo <soporte@luvo.test>");
  });

  it("el nombre escrito por el dueño no puede romper el encabezado ni colar otro destinatario", () => {
    const evil = 'Mary"\r\nBcc: robo@x.test <a@b.test>';
    const name = cleanSenderName(evil);
    expect(name).not.toMatch(/[\r\n"<>]/);
    expect(name.length).toBeLessThanOrEqual(60);
  });
});

describe("la marca de un correo es la del negocio de quien lo recibe", () => {
  beforeEach(() => {
    rows = [];
  });

  it("sin cuenta o sin negocio (registro a medias), la marca de la plataforma", async () => {
    expect(await getBrandingForUser(null)).toEqual(DEFAULT_BRANDING);
    expect(await getBrandingForUser(undefined)).toEqual(DEFAULT_BRANDING);
    expect(await getBrandingForUser("usr_sin_negocio")).toEqual(DEFAULT_BRANDING);
  });

  it("con negocio, la marca guardada en SU negocio", async () => {
    rows = [{ metadata: JSON.stringify({ branding: { name: "Studio Mary", accent: "#0328ba" } }) }];
    expect((await getBrandingForUser("usr_mary")).name).toBe("Studio Mary");
  });

  it("un negocio sin marca propia usa la de la plataforma (nunca la de otro)", async () => {
    rows = [{ metadata: null }];
    expect((await getBrandingForUser("usr_nuevo")).name).toBe(DEFAULT_BRANDING.name);
  });
});

/**
 * Guardarraíl: la causa del error original era `getBranding()` SIN organización —«la única
 * organización de la instancia»— en quienes mandan correos. Con varios negocios devuelve el primero.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

describe("guardarraíl: ningún correo sale con la marca equivocada", () => {
  const files = walk("src/server");

  it("quien manda correos no pide la marca «de la instancia» (getBranding sin negocio)", () => {
    const culpables = files.filter((p) => {
      const s = readFileSync(p, "utf8");
      return /\bsendMail\(/.test(s) && /getBranding\(\s*\)/.test(s);
    });
    expect(culpables).toEqual([]);
  });

  it("todo sendMail lleva el nombre de la marca como remitente", () => {
    const sinNombre = files.filter((p) => {
      if (p.endsWith("mailer.ts")) return false;
      const s = readFileSync(p, "utf8");
      return /\bsendMail\(\{[^}]*\}\)/.test(s.replace(/\n/g, " ")) && !/fromName/.test(s);
    });
    expect(sinNombre).toEqual([]);
  });
});
