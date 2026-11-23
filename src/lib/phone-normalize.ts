/**
 * Normalización de teléfonos: PURA, sin entorno ni red.
 *
 * Vive aparte de `lib/meta/client.ts` (que importa el entorno del servidor y la API de Meta) para que también la
 * pueda usar el navegador —p. ej. la validación en vivo de «Números ignorados»—. `lib/meta/client.ts` la
 * reexporta: quien ya importaba `normalizeMx` o `normalizeRecipient` de ahí no cambia.
 */

/**
 * Normaliza un número al formato canónico. Números móviles de México llegan
 * de Meta como `521` + 10 dígitos (13 en total); enviar con ese `1` extra
 * produce el error 131030 — se usa `52` + 10 dígitos.
 *
 * Desde la identidad resiliente (003) esta normalización es SIMÉTRICA: se
 * aplica también al escribir la identidad del contacto en la ingesta
 * (`wa_identity`), para que `521...` y `52...` resuelvan al mismo contacto.
 */
export function normalizeMx(phone: string): string {
  if (/^521\d{10}$/.test(phone)) {
    return `52${phone.slice(3)}`;
  }
  return phone;
}

/**
 * Troncales que WhatsApp REPORTA pero que no se usan para ENVIAR, y que la
 * identidad deja intactos a propósito.
 *
 * A diferencia de México, aquí la normalización NO puede ser simétrica: si la
 * ingesta reescribiera la identidad, dejaría de coincidir con el `wa_id` que
 * Meta manda en cada webhook —y con el que un cerebro externo consulta el
 * gateway—, así que el contacto se partiría en dos. Se normaliza solo el
 * número que viaja por el cable.
 *
 * Para agregar un país: una línea aquí y su caso en
 * `tests/unit/meta-client.test.ts`.
 */
const SEND_ONLY_TRUNKS = [
  // Argentina: Meta reporta `549` + 10 dígitos; se envía sin el 9 (issue #35).
  { reported: "549", dialable: "54", nationalDigits: 10 },
] as const;

/**
 * El número tal como hay que mandárselo a Meta.
 *
 * Es lo que la identidad ya canoniza, MÁS los troncales que solo estorban al
 * enviar. Ojo con el alcance real del problema que arregla: el `131030`
 * ("Recipient phone number not in allowed list") viene de la lista de
 * destinatarios de prueba, que solo existe MIENTRAS el negocio no está
 * verificado. Ya en producción no hay lista y Meta acepta las dos formas —
 * normaliza internamente y responde el `wa_id` con el troncal puesto. O sea:
 * esto desatasca la puesta en marcha, que es justo cuando una agencia está
 * probando la instancia y el mensaje de error la manda a revisar una lista de
 * permitidos que está bien.
 */
export function normalizeRecipient(phone: string): string {
  const canonical = normalizeMx(phone);
  for (const trunk of SEND_ONLY_TRUNKS) {
    const expected = trunk.reported.length + trunk.nationalDigits;
    if (canonical.length === expected && canonical.startsWith(trunk.reported)) {
      return trunk.dialable + canonical.slice(trunk.reported.length);
    }
  }
  return canonical;
}
