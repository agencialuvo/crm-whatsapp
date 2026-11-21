import { describe, expect, it } from "vitest";
import { isBlockedHost, isMetaMediaUrl, validatePublicHttpUrl } from "@/lib/net-guard";

/**
 * Guardas de red puras: qué hosts son internos (SSRF) y qué URLs de descarga son de Meta (el token de WhatsApp
 * solo viaja a ellas).
 */

describe("isBlockedHost", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "api.localhost",
    "mi-servicio.local",
    "db.internal",
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.169.254", // metadata de la nube
    "100.64.0.1", // CGNAT
    "100.127.255.255",
    "198.18.0.1",
    "224.0.0.1", // multicast
    "255.255.255.255",
    "::1",
    "::",
    "[::1]",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1", // IPv4 mapeada en IPv6
    "::ffff:7f00:1", // la misma, en hex (así la normaliza `new URL`)
    "::ffff:a9fe:a9fe", // 169.254.169.254
    "localhost.", // punto final
  ])("bloquea %s", (h) => {
    expect(isBlockedHost(h)).toBe(true);
  });

  it.each([
    "api.openai.com",
    "openrouter.ai",
    "8.8.8.8",
    "172.15.0.1", // justo antes del rango privado
    "172.32.0.1", // justo después
    "100.63.255.255",
    "100.128.0.1",
    "169.253.1.1",
    "192.169.0.1",
    "2606:4700::1111",
    "::ffff:808:808", // 8.8.8.8 mapeada
    // Antes se bloqueaban por empezar con «fc»/«fd» aunque son nombres, no IPv6.
    "fd.ejemplo.com",
    "fcm.googleapis.com",
  ])("permite %s", (h) => {
    expect(isBlockedHost(h)).toBe(false);
  });
});

describe("validatePublicHttpUrl", () => {
  it("acepta una URL pública http(s)", () => {
    expect(validatePublicHttpUrl("https://api.proveedor.com/v1/chat/completions")).toBeNull();
    expect(validatePublicHttpUrl("http://api.proveedor.com:8080/v1")).toBeNull();
  });

  it.each([
    "http://localhost:3000/v1",
    "http://127.0.0.1/v1",
    "http://[::1]/v1",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/v1",
    "http://192.168.0.1/v1",
    // `new URL` normaliza estas formas raras de 127.0.0.1:
    "http://2130706433/v1", // decimal
    "http://0x7f.0.0.1/v1", // hex
    "http://0177.0.0.1/v1", // octal
    "http://127.1/v1", // abreviada
    "http://[::ffff:127.0.0.1]/v1",
  ])("rechaza %s por red interna", (u) => {
    expect(validatePublicHttpUrl(u)).toMatch(/red interna o local/);
  });

  it("rechaza lo que no es http(s) o está mal escrito", () => {
    expect(validatePublicHttpUrl("ftp://api.proveedor.com")).toMatch(/http\(s\)/);
    expect(validatePublicHttpUrl("file:///etc/passwd")).toMatch(/http\(s\)/);
    expect(validatePublicHttpUrl("no es una url")).toMatch(/http\(s\)/);
  });

  it("rechaza credenciales dentro de la URL", () => {
    expect(validatePublicHttpUrl("https://user:pass@api.proveedor.com/v1")).toMatch(/usuario/);
  });

  it("allowLocal (solo con los mocks) deja pasar lo local pero no lo malformado", () => {
    expect(validatePublicHttpUrl("http://localhost:3000/api/dev/ai-mock", { allowLocal: true })).toBeNull();
    expect(validatePublicHttpUrl("ftp://localhost", { allowLocal: true })).toMatch(/http\(s\)/);
  });
});

describe("isMetaMediaUrl", () => {
  it.each([
    "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123",
    "https://scontent.xx.fbcdn.net/v/t1.0/foto.jpg",
    "https://mmg.whatsapp.net/d/f/abc.enc",
    "https://FBSBX.com/x",
  ])("acepta %s", (u) => {
    expect(isMetaMediaUrl(u)).toBe(true);
  });

  it.each([
    "https://evil.example.com/media",
    "http://lookaside.fbsbx.com/x", // sin TLS
    "https://lookaside.fbsbx.com:8443/x", // puerto explícito
    "https://user:pw@lookaside.fbsbx.com/x",
    "https://fbsbx.com.evil.com/x", // sufijo engañoso
    "https://evilfbsbx.com/x", // no es subdominio
    "https://notfbcdn.net/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:3000/x",
    "no es una url",
    "",
  ])("rechaza %s", (u) => {
    expect(isMetaMediaUrl(u)).toBe(false);
  });

  it("el origen del mock solo cuenta si se pasa explícitamente", () => {
    const url = "http://localhost:3000/api/dev/wa-mock/media-file/media1";
    expect(isMetaMediaUrl(url)).toBe(false);
    expect(isMetaMediaUrl(url, "http://localhost:3000")).toBe(true);
    expect(isMetaMediaUrl("http://localhost:4000/x", "http://localhost:3000")).toBe(false);
  });
});
