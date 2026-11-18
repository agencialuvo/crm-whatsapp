import { limpiarSubidasPendientes } from "@/server/medios/store";
import { pruneWaMediaCache } from "@/server/whatsapp/media-cache";

/**
 * 048 — Mantenimiento horario de Medios, del núcleo (corre siempre, dentro del proceso): borra las subidas directas que
 * se firmaron pero nunca se confirmaron (y su objeto huérfano en R2) y poda las filas vencidas de la caché del
 * `media_id` de WhatsApp. Nunca lanza.
 */

const INTERVAL_MS = 60 * 60 * 1000;

type State = { timer: NodeJS.Timeout | null; running: boolean };
const g = globalThis as unknown as { __voceroMediaMaintenance?: State };
const state = (): State => (g.__voceroMediaMaintenance ??= { timer: null, running: false });

export async function tickMediaMaintenance(now = new Date()): Promise<void> {
  const s = state();
  if (s.running) return;
  s.running = true;
  try {
    const n = await limpiarSubidasPendientes(now);
    if (n > 0) console.log(`[medios] ${n} subida(s) sin confirmar se limpiaron`);
    await pruneWaMediaCache(now);
  } catch (err) {
    console.error("[medios] el mantenimiento falló:", err instanceof Error ? err.message : err);
  } finally {
    s.running = false;
  }
}

export function startMediaMaintenance(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => void tickMediaMaintenance(), INTERVAL_MS);
  s.timer.unref?.();
}
