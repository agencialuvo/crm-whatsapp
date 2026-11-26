/**
 * Mejora 3 — Textos del enlace para que un profesional conecte su Google Calendar (compartidos entre el
 * servidor y las páginas; sin dependencias de servidor).
 */

export const STAFF_INVITE_MESSAGES: Record<string, string> = {
  not_found: "Este enlace no existe. Pide uno nuevo a tu negocio.",
  expired: "Este enlace venció (dura 24 horas). Pide uno nuevo a tu negocio.",
  used: "Este enlace ya se usó. Si necesitas volver a conectar, pide uno nuevo a tu negocio.",
  revoked: "Este enlace se anuló. Pide uno nuevo a tu negocio.",
  inactive: "Tu perfil en el negocio está desactivado: no hace falta conectar el calendario.",
  denied: "Cancelaste el permiso en Google. No se conectó nada; puedes volver a abrir el enlace.",
  state: "El intento de conexión caducó. Vuelve a abrir el enlace y prueba otra vez.",
  exchange_failed: "Google no aceptó la autorización. Vuelve a abrir el enlace y prueba otra vez.",
  no_refresh_token:
    "Google no entregó el permiso permanente. Quita el acceso de esta app en tu cuenta de Google y vuelve a abrir el enlace.",
  missing_scope: "Falta el permiso para ver los eventos de tu calendario: márcalo en la pantalla de Google.",
  test_failed: "La cuenta se autorizó, pero no se pudo leer su calendario. Prueba otra vez.",
  business_account:
    "Esa es la cuenta de Google del negocio. Conecta TU cuenta personal (la de tu calendario).",
};

export function staffInviteMessage(code: string | null | undefined): string {
  return (code && STAFF_INVITE_MESSAGES[code]) || "No se pudo conectar tu calendario. Vuelve a abrir el enlace.";
}

/** El texto para compartir el enlace por WhatsApp (wa.me). */
export function staffInviteShareText(input: { organizationName?: string | null; staffName: string; url: string }): string {
  const who = input.organizationName ? ` de ${input.organizationName}` : "";
  return `Hola ${input.staffName}: para no agendarte citas cuando estás ocupado/a, conecta tu Google Calendar con la agenda${who}. Vocero solo ve tus horarios ocupados, nunca los detalles. El enlace vence en 24 horas: ${input.url}`;
}

/** `wa.me` con el teléfono (solo dígitos) o sin él (elige el contacto en WhatsApp). */
export function whatsappShareUrl(phone: string | null | undefined, text: string): string {
  const digits = (phone ?? "").replace(/\D+/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
