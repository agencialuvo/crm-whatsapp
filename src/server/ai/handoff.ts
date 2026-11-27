/**
 * Patrón de RESPALDO de intención de escalado (FR-022). Se evalúa sobre el mensaje del cliente ANTES del LLM:
 * si coincide, el traspaso ocurre aunque el modelo no lo detecte. Por eso tiene que ser de ALTA PRECISIÓN: un
 * falso positivo pausa la IA y le avisa al equipo sin motivo. Los casos dudosos los decide el modelo, que tiene
 * su propia regla («si el cliente pide hablar con una persona → handoff»).
 *
 * Mejora 6 — La versión anterior buscaba fragmentos sueltos y sin límites de palabra: «persona» coincidía dentro
 * de «personalizado» y «un asesor» en cualquier pregunta («¿tienen un asesor de imagen?»). Ahora exige:
 *  - palabras COMPLETAS, sobre el texto sin tildes ni mayúsculas;
 *  - un verbo de contacto seguido de «con / a» y la persona («hablar con un humano», «me pasas a un asesor»),
 *    un pedido directo («quiero un asesor», «atención humana», «una persona real») o el mensaje que es solo eso
 *    («asesor», «humano por favor»);
 *  - que un cargo con calificador sea un servicio o un rol, no un pedido: «asesor de imagen», «asesor fiscal»,
 *    «agente virtual», «plan personalizado» no disparan;
 *  - que no esté negado («no quiero hablar con un humano»).
 */

/** Sin tildes, en minúsculas y con espacios simples. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Personas: nunca son un servicio. */
const PERSONA = "(?:humano|humana|humanos|persona|personas|alguien|operador|operadora|encargado|encargada|gerente|dueno|duena|responsable)";
/** Cargos que también son nombres de servicios o productos: no cuentan si llevan calificador. */
const CARGO = "(?:asesor|asesora|asesores|agente|ejecutivo|ejecutiva)";
const CALIFICADOR =
  "(?!\\s+(?:de|del|en|para|fiscal|financier[oa]s?|personal|personales|comercial|inmobiliari[oa]|legal|contable|virtual|ia|automatico|automatica|digital|tributari[oa])\\b)";
const ALGUIEN = `(?:${PERSONA}\\b|${CARGO}\\b${CALIFICADOR})`;
const ARTICULO = "(?:(?:un|una|el|la|al|algun|alguna|tu|su|sus|los|las)\\s+)?";

/** Verbos que admiten palabras en medio («hablar directamente con…», «comunicarme por favor con…»). */
const VERBO_HABLAR = "(?:hablar\\w*|hable|hablo|comunicar\\w*|comunicame|comunicas|contactar\\w*|contacta(?:me)?)";
/** Verbos que van directo a la persona («me pasas a un asesor», «transfiéreme con alguien»). */
const VERBO_PASAR = "(?:pasar|pasa|pasas|pasame|pasan|pase|pases|pasarme|pasarnos|transfiere\\w*|transferir\\w*|conecta\\w*|derivame|deriva)";

const PATRONES: RegExp[] = [
  // «quiero hablar (directamente) con un humano», «necesito comunicarme con alguien»
  new RegExp(`\\b${VERBO_HABLAR}\\b(?:\\s+\\S+){0,3}?\\s+(?:con|a)\\s+${ARTICULO}${ALGUIEN}`, "g"),
  // «me pasas a un asesor», «pásame con una persona»
  new RegExp(`\\b${VERBO_PASAR}\\b(?:\\s+(?:me|nos|por favor|porfa|ya))?\\s+(?:con|a|al)\\s+${ARTICULO}${ALGUIEN}`, "g"),
  // «que me atienda una persona»
  new RegExp(`\\b(?:me|nos)\\s+atienda(?:n)?\\s+${ARTICULO}${PERSONA}\\b`, "g"),
  // «quiero un asesor», «necesito una persona real»
  new RegExp(`\\b(?:quiero|necesito|prefiero|dame|pasame)\\s+(?:a\\s+)?(?:un|una)\\s+(?:humano|humana|persona real|${CARGO}\\b${CALIFICADOR})`, "g"),
  // «atención humana», «atención de una persona», «una persona real»
  /\batencion (?:humana|de una persona|de un humano)\b/g,
  /\b(?:una )?persona real\b/g,
  // El mensaje es solo el pedido: «asesor», «un humano por favor», «agente!»
  new RegExp(`^(?:un |una |el |la )?(?:humano|humana|persona|asesor|asesora|agente|operador|operadora)(?: por favor| porfa| pls| please)?[\\s.!?¡¿]*$`, "g"),
];

/** «no quiero / no necesito / no me pases…» justo antes del pedido lo anula. */
const NEGACION = /\bno\s+(?:(?:me|nos|te|lo|la)\s+)?(?:(?:quiero|necesito|hace falta|es necesario|deseo|pidas|pases)\s+)?(?:(?:que\s+)?(?:me|nos)\s+)?$/;

export function matchesHandoffIntent(text: string): boolean {
  const t = normalizar(text);
  if (!t) return false;
  for (const patron of PATRONES) {
    patron.lastIndex = 0;
    for (const m of t.matchAll(patron)) {
      const antes = t.slice(Math.max(0, (m.index ?? 0) - 30), m.index ?? 0);
      if (!NEGACION.test(antes)) return true;
    }
  }
  return false;
}

/**
 * Lo que oye el cliente cuando el patrón de respaldo lo traspasa.
 *
 * El camino del modelo se despide con su `farewell`; este no mandaba NADA, y
 * justo atrapa las peticiones más directas («quiero hablar con un humano»).
 * El traspaso ocurría por dentro, pero del lado de WhatsApp se leía como que
 * el bot había dejado de contestar a quien pidió una persona.
 *
 * Es fijo porque el perfil del agente no tiene un campo para esto
 * (`escalationRules` dice CUÁNDO escalar, no qué decir) y el turno corta
 * antes del modelo a propósito: no hay de dónde sacar otro texto. No promete
 * un plazo ni un nombre que el CRM no conoce.
 */
export const HANDOFF_BACKUP_ACK =
  "Claro, te comunico con una persona del equipo. En breve te responden.";
