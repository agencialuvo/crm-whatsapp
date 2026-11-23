import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cleanLabel,
  ignoreKeyOf,
  ignoreKeysOfContact,
  NEEDS_COUNTRY_CODE,
  parseIgnoredInput,
  phoneKeyOf,
  primaryIgnoreKey,
} from "@/lib/ignored-number";

const key = (s: string) => {
  const r = ignoreKeyOf(s);
  if (!r.ok) throw new Error(`${s}: ${r.error}`);
  return r.key;
};
const error = (s: string) => {
  const r = ignoreKeyOf(s);
  if (r.ok) throw new Error(`${s} debía fallar`);
  return r.error;
};

describe("números ignorados: la llave de un número escrito", () => {
  it("quita +, espacios, guiones y paréntesis", () => {
    expect(key("+51 987 654 321")).toBe("51987654321");
    expect(key("+51-987-654-321")).toBe("51987654321");
    expect(key("+51 (987) 654.321")).toBe("51987654321");
    expect(key("  +51987654321  ")).toBe("51987654321");
  });

  it("el prefijo 00 equivale al +", () => {
    expect(key("0051987654321")).toBe("51987654321");
    expect(key("00 51 987 654 321")).toBe("51987654321");
  });

  it("México: 521 + 10 dígitos pasa a 52, igual que la identidad del contacto", () => {
    expect(key("+52 1 55 1234 5678")).toBe("525512345678");
    expect(key("+52 55 1234 5678")).toBe("525512345678");
    expect(key("5215512345678")).toBe("525512345678");
  });

  it("Argentina: 549 + 10 dígitos pasa a 54, igual que el envío", () => {
    expect(key("+54 9 11 2345 6789")).toBe("541123456789");
    expect(key("+54 11 2345 6789")).toBe("541123456789");
    expect(key("+54 9 11 2345 6789")).toBe(key("+54 11 2345 6789"));
  });

  it("rechaza lo que no lleva código de país (10 dígitos o menos sin + ni 00)", () => {
    expect(error("5512345678")).toBe(NEEDS_COUNTRY_CODE);
    expect(error("987654321")).toBe(NEEDS_COUNTRY_CODE);
    expect(error("(55) 1234-5678")).toBe(NEEDS_COUNTRY_CODE);
    expect(error("12345")).toBe(NEEDS_COUNTRY_CODE);
    expect(NEEDS_COUNTRY_CODE).toBe("Incluye el código de país, por ejemplo +51…");
  });

  it("un código de país no empieza en 0", () => {
    expect(error("0987654321")).toBe(NEEDS_COUNTRY_CODE);
    expect(error("+0987654321")).toBe(NEEDS_COUNTRY_CODE);
  });

  it("sin + pero con 11 dígitos o más se asume que ya trae país", () => {
    expect(key("51987654321")).toBe("51987654321");
  });

  it("largo: de 8 a 15 dígitos", () => {
    expect(error("+1234567")).toMatch(/entre 8 y 15/);
    expect(error("+1234567890123456")).toMatch(/entre 8 y 15/);
    expect(key("+12345678")).toBe("12345678");
    expect(key("+123456789012345")).toBe("123456789012345");
  });

  it("solo dígitos: letras o un + en medio se rechazan", () => {
    expect(error("+51 98a 654 321")).toMatch(/Solo puede llevar dígitos/);
    expect(error("+51+987654321")).toMatch(/Solo puede llevar dígitos/);
    expect(error("abc")).toMatch(/Solo puede llevar dígitos/);
  });

  it("vacío", () => {
    expect(error("   ")).toBe("Escribe un número.");
  });
});

describe("números ignorados: el teléfono que ya guardó el sistema", () => {
  it("sale con la misma llave que lo escrito a mano", () => {
    expect(phoneKeyOf("525512345678")).toBe(key("+52 1 55 1234 5678"));
    expect(phoneKeyOf("5215512345678")).toBe("525512345678");
    expect(phoneKeyOf("5491123456789")).toBe(key("+54 11 2345 6789"));
    expect(phoneKeyOf("51987654321")).toBe(key("+51 987 654 321"));
  });

  it("sin dígitos no hay llave", () => {
    expect(phoneKeyOf(null)).toBeNull();
    expect(phoneKeyOf("")).toBeNull();
    expect(phoneKeyOf("bsuid:abc")).toBeNull();
  });
});

describe("números ignorados: las llaves de un contacto", () => {
  it("WhatsApp con teléfono: la llave es el teléfono", () => {
    const c = { channel: "whatsapp" as const, waIdentity: "51987654321", phone: "51987654321" };
    expect(ignoreKeysOfContact(c)).toEqual(["51987654321"]);
    expect(primaryIgnoreKey(c)).toBe("51987654321");
  });

  it("WhatsApp México con 521: se compara como 52", () => {
    const c = { channel: "whatsapp" as const, waIdentity: "5215512345678", phone: "5215512345678" };
    expect(ignoreKeysOfContact(c)).toEqual(["525512345678"]);
  });

  it("WhatsApp con BSUID y teléfono conocido: ignorado por cualquiera de los dos", () => {
    const c = { channel: "whatsapp" as const, waIdentity: "bsuid:AB12", phone: "51987654321", waUserId: "AB12" };
    expect(ignoreKeysOfContact(c)).toEqual(["51987654321", "bsuid:AB12"]);
  });

  it("WhatsApp solo con BSUID", () => {
    const c = { channel: "whatsapp" as const, waIdentity: "bsuid:AB12", phone: null };
    expect(ignoreKeysOfContact(c)).toEqual(["bsuid:AB12"]);
  });

  it("otros canales: la identidad cruda es la llave, sin tocarla", () => {
    expect(ignoreKeysOfContact({ channel: "instagram", waIdentity: "ig:178414" })).toEqual(["ig:178414"]);
    expect(ignoreKeysOfContact({ channel: "messenger", waIdentity: "fb:99" })).toEqual(["fb:99"]);
    expect(ignoreKeysOfContact({ channel: "tiktok", waIdentity: "tt:abc" })).toEqual(["tt:abc"]);
  });

  it("sin identidad no hay llave", () => {
    expect(primaryIgnoreKey({ channel: "instagram", waIdentity: "  " })).toBeNull();
  });
});

describe("números ignorados: la nota", () => {
  it("se recorta y vacía es null", () => {
    expect(cleanLabel("  Mamá ")).toEqual({ ok: true, label: "Mamá" });
    expect(cleanLabel("   ")).toEqual({ ok: true, label: null });
    expect(cleanLabel(null)).toEqual({ ok: true, label: null });
  });

  it("80 caracteres sí, 81 no", () => {
    expect(cleanLabel("a".repeat(80)).ok).toBe(true);
    expect(cleanLabel("a".repeat(81)).ok).toBe(false);
  });
});

describe("números ignorados: leer una lista pegada", () => {
  it("un número por línea, saltando las vacías", () => {
    const r = parseIgnoredInput("+51 987 654 321\n\n  \r\n+52 55 1234 5678\n");
    expect(r.invalid).toEqual([]);
    expect(r.valid).toEqual([
      { line: 1, key: "51987654321", label: null },
      { line: 4, key: "525512345678", label: null },
    ]);
  });

  it("nota tras coma, punto y coma, barra, tabulador o guion", () => {
    const r = parseIgnoredInput(
      ["+51 987 654 321, Mamá", "+51 987 654 322; Papá", "+51 987 654 323 | Tía Rosa", "+51 987 654 324\tContador", "+51 987 654 325 - Proveedor"].join("\n")
    );
    expect(r.invalid).toEqual([]);
    expect(r.valid.map((e) => e.label)).toEqual(["Mamá", "Papá", "Tía Rosa", "Contador", "Proveedor"]);
    expect(r.valid.map((e) => e.key)).toEqual(["51987654321", "51987654322", "51987654323", "51987654324", "51987654325"]);
  });

  it("una nota que empieza con dígitos va tras un separador", () => {
    const r = parseIgnoredInput("+51 987 654 321, 2 hermanos");
    expect(r.valid).toEqual([{ line: 1, key: "51987654321", label: "2 hermanos" }]);
  });

  it("las líneas malas vuelven con su línea y motivo, sin tumbar las buenas", () => {
    const r = parseIgnoredInput(
      ["+51 987 654 321", "5512345678", "Mamá", "+1234567", `+51 987 654 322, ${"x".repeat(81)}`].join("\n")
    );
    expect(r.valid.map((e) => e.line)).toEqual([1]);
    expect(r.invalid.map((e) => e.line)).toEqual([2, 3, 4, 5]);
    expect(r.invalid[0]!.reason).toBe(NEEDS_COUNTRY_CODE);
    expect(r.invalid[1]!.reason).toMatch(/No parece un número/);
    expect(r.invalid[2]!.reason).toMatch(/entre 8 y 15/);
    expect(r.invalid[3]!.reason).toMatch(/hasta 80 caracteres/);
  });

  it("letras pegadas al número no se toman por nota", () => {
    const r = parseIgnoredInput("+51987654321abc");
    expect(r.valid).toEqual([]);
    expect(r.invalid[0]!.reason).toMatch(/Solo puede llevar dígitos/);
  });

  it("duplicados: se reportan en su segunda aparición, aunque se escriban distinto", () => {
    const r = parseIgnoredInput(["+51 987 654 321", "0051987654321, otra vez", "+54 9 11 2345 6789", "+54 11 2345 6789"].join("\n"));
    expect(r.valid.map((e) => e.line)).toEqual([1, 3]);
    expect(r.invalid).toEqual([
      { line: 2, text: "0051987654321, otra vez", reason: "Repetido: ya está en la línea 1." },
      { line: 4, text: "+54 11 2345 6789", reason: "Repetido: ya está en la línea 3." },
    ]);
  });

  it("texto vacío", () => {
    expect(parseIgnoredInput("")).toEqual({ valid: [], invalid: [] });
  });
});

describe("números ignorados: la capa de datos", () => {
  const src = readFileSync("src/server/ai/ignored.ts", "utf8");

  it("toda consulta lleva scoped() y respeta el límite", () => {
    expect(src.match(/scoped\(/g)!.length).toBeGreaterThanOrEqual(4);
    expect(src).toContain("IGNORED_LIMIT");
    expect(src).toContain("onConflictDoNothing");
  });

  it("solo LEE contacto y conversación: no pausa ni traspasa (la lista es la fuente de verdad)", () => {
    // Los comentarios lo mencionan para explicarlo; lo que cuenta es el código.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/aiPaused|ai_paused|\.update\(|handoff/i);
  });
});
