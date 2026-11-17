import type { ConversationDto } from "@/lib/types";

/**
 * 042 — La ventana de respuesta de una conversación, calculada en el CLIENTE con su reloj.
 *
 * El servidor manda instantes absolutos (`windowExpiresAt`, `humanWindow.expiresAt`) y su propio reloj
 * (`serverTime`); aquí se deriva qué está abierto en cualquier `ahora`. Es el espejo de `replyWindow`
 * (`src/server/inbox/window.ts`) y debe decir lo mismo que él.
 */

export type WindowFields = Pick<ConversationDto, "windowOpen" | "windowExpiresAt" | "humanWindow">;

export type WindowState = {
  /** La ventana normal del canal está abierta: escribe cualquiera, persona o IA. */
  standardOpen: boolean;
  /** La normal cerró pero una persona todavía puede contestar (Instagram y Messenger). */
  humanOpen: boolean;
  /** Lo que le queda a la ventana que esté abierta, en ms. `Infinity` = no vence. */
  remainingMs: number;
  /** Lo que le queda a la extensión humana, en ms (0 si no hay). */
  humanRemainingMs: number;
};

export function windowStateAt(w: WindowFields, nowMs: number): WindowState {
  const expires = w.windowExpiresAt ? Date.parse(w.windowExpiresAt) : null;
  const standardOpen =
    expires === null ? w.windowOpen : Number.isFinite(expires) && nowMs < expires;
  const humanExpires = w.humanWindow?.expiresAt ? Date.parse(w.humanWindow.expiresAt) : null;
  const humanLeft =
    humanExpires !== null && Number.isFinite(humanExpires) ? Math.max(0, humanExpires - nowMs) : 0;
  const humanOpen = !standardOpen && humanLeft > 0;
  return {
    standardOpen,
    humanOpen,
    remainingMs: standardOpen
      ? expires === null
        ? Infinity
        : Math.max(0, (expires as number) - nowMs)
      : humanOpen
        ? humanLeft
        : 0,
    humanRemainingMs: humanLeft,
  };
}

/** Desde cuánto antes del cierre el reloj late cada segundo. */
export const FINAL_STRETCH_MS = 5 * 60_000;

/**
 * Cuánto esperar al siguiente latido: cada minuto, y cada segundo en el último tramo antes de que algo se
 * cierre. `null` si no hay nada que vigilar (ventana cerrada para siempre o que no vence).
 */
export function nextTickMs(w: WindowFields, nowMs: number): number | null {
  const instants = [w.windowExpiresAt, w.humanWindow?.expiresAt]
    .map((iso) => (iso ? Date.parse(iso) : NaN))
    .filter((t) => Number.isFinite(t) && t > nowMs);
  if (instants.length === 0) return null;
  const nearest = Math.min(...instants) - nowMs;
  return nearest <= FINAL_STRETCH_MS ? 1000 : 60_000;
}

/** El desfase entre el reloj del servidor y el del navegador, en ms (sumar a `Date.now()`). */
export function clockOffsetMs(serverTimeIso: string, nowMs: number = Date.now()): number {
  const server = Date.parse(serverTimeIso);
  return Number.isFinite(server) ? server - nowMs : 0;
}
