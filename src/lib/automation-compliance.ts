/**
 * Automatizaciones — cumplimiento de las políticas de Meta (spec 037). Reglas puras, sin base de datos ni red:
 * qué palabras son una baja y cuántos mensajes automáticos admite un contacto.
 */

/* ─── Bajas ─── */

/** Minúsculas, sin acentos, sin puntuación, espacios colapsados: «¡Quiero darme de BAJA!» → «quiero darme de baja». */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Palabras sueltas: solo valen si el mensaje ENTERO es esa palabra («tengo la presión baja» no es una baja). */
const OPT_OUT_WORDS = new Set([
  "baja",
  "stop",
  "unsubscribe",
  // «cancelar» solo NO: es lo que se contesta a un recordatorio para cancelar la cita.
  "cancelar suscripcion",
  "stop all",
  "no mas",
]);

/** Frases: basta con que un mensaje corto las contenga. */
const OPT_OUT_PHRASES = [
  "no quiero mas mensajes",
  "no quiero recibir mas mensajes",
  "no quiero mas informacion",
  "no me escriban mas",
  "no me escribas mas",
  "no me envien mas",
  "no me envies mas",
  "no me manden mas",
  "no me mandes mas",
  "dejen de escribirme",
  "deja de escribirme",
  "dejen de enviarme",
  "deja de enviarme",
  "dejen de mandarme",
  "deja de mandarme",
  "darme de baja",
  "dar de baja",
  "dame de baja",
  "denme de baja",
  "borrenme de la lista",
  "quitenme de la lista",
  "quita me de la lista",
  "no deseo recibir mas",
  "do not contact",
  "stop messaging",
  "stop sending",
  "stop texting",
];

const OPT_IN_WORDS = new Set(["start", "reanudar", "suscribirme", "suscribir", "volver a suscribirme"]);
const OPT_IN_PHRASES = ["quiero recibir mensajes", "quiero volver a recibir", "volver a recibir mensajes", "reanudar mensajes"];

/** Más largo que esto ya no es una petición de baja sino una conversación: no se interpreta. */
const MAX_PHRASE_CHARS = 80;

export type OptOutIntent = "opt_out" | "opt_in";

/**
 * ¿El mensaje pide dejar de recibir mensajes (o volver a recibirlos)? `null` si no es ninguna de las dos.
 * Conservador a propósito: un falso positivo calla a un cliente que sí quería los mensajes.
 */
export function detectOptOutIntent(text: string | null | undefined): OptOutIntent | null {
  if (!text) return null;
  const t = normalizeForMatch(text);
  if (!t || t.length > MAX_PHRASE_CHARS) return null;
  // La reactivación primero: «quiero volver a recibir» no debe leerse como baja por contener «recibir».
  if (OPT_IN_WORDS.has(t) || OPT_IN_PHRASES.some((p) => t.includes(p))) return "opt_in";
  if (OPT_OUT_WORDS.has(t) || OPT_OUT_PHRASES.some((p) => t.includes(p))) return "opt_out";
  return null;
}

/* ─── Límite de frecuencia ─── */

/**
 * Cuántos mensajes automáticos admite un contacto en una ventana móvil, sumando todos los flujos. Un solo lugar:
 * subirlo o bajarlo es cambiar estos dos números.
 */
export const AUTOMATION_RATE_LIMIT = { maxMessages: 6, windowHours: 24 } as const;

/** Cuánto puede quedar retenida una tarea por el límite antes de descartarse (un recordatorio tardío es peor que ninguno). */
export const RATE_LIMIT_MAX_HOLD_MS = 24 * 3_600_000;

export type RateLimitDecision = { allowed: true; used: number } | { allowed: false; used: number; retryAt: Date };

/**
 * ¿Cabe un mensaje más? `sentAt` son los envíos automáticos exitosos del contacto (cualquier orden). Si no cabe,
 * `retryAt` es el instante en que el envío que estorba sale de la ventana: ahí vuelve a haber hueco.
 */
export function decideRateLimit(input: {
  sentAt: readonly Date[];
  now: Date;
  maxMessages?: number;
  windowHours?: number;
}): RateLimitDecision {
  const max = input.maxMessages ?? AUTOMATION_RATE_LIMIT.maxMessages;
  const windowMs = (input.windowHours ?? AUTOMATION_RATE_LIMIT.windowHours) * 3_600_000;
  const since = input.now.getTime() - windowMs;
  const inWindow = input.sentAt.map((d) => d.getTime()).filter((t) => t > since).sort((a, b) => a - b);
  if (inWindow.length < max) return { allowed: true, used: inWindow.length };
  // Con `n` envíos y tope `max`, hay hueco cuando han salido de la ventana `n - max + 1` de los más antiguos.
  const blocker = inWindow[inWindow.length - max]!;
  return { allowed: false, used: inWindow.length, retryAt: new Date(blocker + windowMs) };
}

/** ¿Lleva demasiado retenida por el límite? Entonces se descarta en vez de posponerse otra vez. */
export function rateLimitHoldExpired(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() > RATE_LIMIT_MAX_HOLD_MS;
}
