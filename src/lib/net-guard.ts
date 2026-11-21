/**
 * Guardas de red PURAS (sin DNS ni fetch): qué URLs puede tocar el servidor.
 *
 * - `validatePublicHttpUrl`: para URLs que escribe quien administra (la base URL del proveedor de IA). Rechaza
 *   `localhost`, loopback, redes privadas, link-local (incluye el metadata de la nube, 169.254.169.254), CGNAT,
 *   multicast/reservadas, IPv6 local/ULA, IPv4 mapeada en IPv6 y nombres internos (`.local`, `.internal`).
 *   `new URL` ya normaliza las formas raras de IPv4 (decimal `2130706433`, hex `0x7f.1`) a `127.0.0.1`.
 *   Es una lista sobre el host LITERAL: no resuelve DNS, así que no detiene un DNS rebinding; cierra el caso
 *   común sin costo.
 * - `isMetaMediaUrl`: la URL de descarga de un adjunto llega en una respuesta de Meta y se pide con el token de
 *   WhatsApp en `Authorization`. Si no es un host de Meta, ese token NO se manda.
 *
 * Los mocks del entorno de pruebas (`WA_MOCK_ENABLED`, nunca en producción) viven en `localhost`: quien llama pasa
 * `allowLocal`/`mockOrigin` solo con `isMockEnabled()`.
 */

/** ¿El host (sin corchetes) apunta a una red interna, local o reservada? */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "") return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localdomain")) return true;

  // IPv6 literal (lleva ":"): no se mira el prefijo de un nombre cualquiera como «fd.ejemplo.com».
  if (h.includes(":")) {
    if (h === "::" || h === "::1") return true;
    if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true; // fe80::/10
    if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULA fc00::/7
    if (h.startsWith("ff")) return true; // multicast
    const mapped = /^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(h);
    if (mapped) {
      if (mapped[1]) return isBlockedHost(mapped[1]);
      const hi = parseInt(mapped[2]!, 16);
      const lo = parseInt(mapped[3]!, 16);
      return isBlockedHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return false;
  }

  const parts = h.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const [a, b, c] = parts.map(Number) as [number, number, number];
    if (a === 0) return true; // «esta red» y 0.0.0.0
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local: metadata de la nube
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // pruebas de red 198.18.0.0/15
    if (a >= 224) return true; // multicast y reservadas
  }
  return false;
}

/**
 * Para una URL que escribe quien administra: `null` si se puede usar, o el motivo en español.
 * `allowLocal`: solo con los mocks habilitados (`isMockEnabled()`), que nunca existen en producción.
 */
export function validatePublicHttpUrl(url: string, opts: { allowLocal?: boolean } = {}): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "La base URL no es una dirección http(s) válida";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "La base URL no es una dirección http(s) válida";
  }
  if (parsed.username || parsed.password) {
    return "La base URL no puede llevar usuario ni contraseña";
  }
  if (!opts.allowLocal && isBlockedHost(parsed.hostname)) {
    return "La base URL no puede apuntar a una red interna o local";
  }
  return null;
}

/** Dominios desde los que Meta sirve los adjuntos de WhatsApp (y los creativos). */
const META_MEDIA_DOMAINS = ["fbsbx.com", "fbcdn.net", "facebook.com", "whatsapp.net", "whatsapp.com", "cdninstagram.com"];

/**
 * ¿Se le puede mandar el token de WhatsApp a esta URL de descarga? Solo https, sin usuario ni puerto explícito y un
 * host de Meta. `mockOrigin` (el origen del wa-mock) solo se pasa con los mocks habilitados.
 */
export function isMetaMediaUrl(raw: string, mockOrigin: string | null = null): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (mockOrigin && u.origin === mockOrigin) return true;
  if (u.protocol !== "https:" || u.port !== "") return false;
  const h = u.hostname.toLowerCase();
  return META_MEDIA_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}
