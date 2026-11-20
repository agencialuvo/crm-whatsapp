import { limpiarSubidasPendientes } from "@/server/medios/store";
import { reconciliarMedios } from "@/server/medios/reconciliar";
import { reintentarAdjuntosPendientes } from "@/server/medios/reintentar-adjuntos";
import { pruneWaMediaCache } from "@/server/whatsapp/media-cache";

/**
 * 048 — Mantenimiento de Medios, del núcleo (corre siempre, dentro del proceso). Nunca lanza.
 *
 * - Cada hora: borra las subidas directas que se firmaron pero nunca se confirmaron (y su objeto huérfano en R2) y poda las
 *   filas vencidas de la caché del `media_id` de WhatsApp.
 * - Hallazgo H, una vez al día: reconcilia archivos huérfanos entre la base, R2 y el disco (`reconciliar.ts`). **Por
 *   defecto solo INFORMA en el log**; borra por sí sola únicamente con `MEDIA_RECONCILE_AUTO=on` (y entonces con tope de
 *   100 por corrida y solo lo de más de 72 h). Para borrar a mano y con control: `pnpm reconciliar-medios`.
 * - Hallazgo J, cada 10 minutos: reintenta bajar de Meta los adjuntos entrantes pendientes o fallidos que aún estén dentro de
 *   su vigencia (`reintentar-adjuntos.ts`), con espera creciente, tope por tanda y cortacircuitos.
 */

const INTERVAL_MS = 60 * 60 * 1000;
const RECONCILIAR_CADA_MS = 24 * 60 * 60 * 1000;
const REINTENTO_CADA_MS = 10 * 60 * 1000;
const ON = new Set(["on", "1", "true", "si", "sí", "yes"]);

type State = {
  timer: NodeJS.Timeout | null;
  running: boolean;
  retryTimer: NodeJS.Timeout | null;
  retrying: boolean;
  /** Cuándo fue la última reconciliación (arranca «ahora»: la primera es a las 24 h, no al arrancar). */
  ultimaReconciliacion: number;
  /** Dónde retomar el listado de R2 si la corrida anterior no llegó al final. */
  cursorR2: string | null;
};
const g = globalThis as unknown as { __voceroMediaMaintenance?: State };
const state = (): State => (g.__voceroMediaMaintenance ??= { timer: null, running: false, retryTimer: null, retrying: false, ultimaReconciliacion: Date.now(), cursorR2: null });

const reconciliacionAutomatica = () => ON.has((process.env.MEDIA_RECONCILE_AUTO ?? "").trim().toLowerCase());

export async function tickMediaMaintenance(now = new Date()): Promise<void> {
  const s = state();
  if (s.running) return;
  s.running = true;
  try {
    const n = await limpiarSubidasPendientes(now);
    if (n > 0) console.log(`[medios] ${n} subida(s) sin confirmar se limpiaron`);
    await pruneWaMediaCache(now);
    if (now.getTime() - s.ultimaReconciliacion >= RECONCILIAR_CADA_MS) {
      s.ultimaReconciliacion = now.getTime();
      await tickReconciliacion(now);
    }
  } catch (err) {
    console.error("[medios] el mantenimiento falló:", err instanceof Error ? err.message : err);
  } finally {
    s.running = false;
  }
}

/** Una corrida de la reconciliación de huérfanos. Informe por defecto; borra solo con `MEDIA_RECONCILE_AUTO=on`. */
export async function tickReconciliacion(now = new Date()): Promise<void> {
  const s = state();
  try {
    const auto = reconciliacionAutomatica();
    const r = await reconciliarMedios({ now, aplicar: auto, cursorR2: s.cursorR2, ...(auto ? { maxBorrar: 100, edadMinimaMs: 72 * 3600_000 } : {}) });
    s.cursorR2 = r.siguienteCursorR2;
    const mb = (r.bytes / 1_048_576).toFixed(1);
    if (r.abortado) console.warn(`[medios] reconciliación frenada: ${r.abortado}`);
    else if (auto && r.borrados + r.fallidos > 0) console.log(`[medios] reconciliación: ${r.borrados} huérfano(s) borrado(s) (${mb} MB)${r.fallidos ? `, ${r.fallidos} no se pudieron borrar` : ""}`);
    else if (!auto && r.huerfanos.length > 0) {
      console.log(`[medios] reconciliación (solo informe): ${r.huerfanos.length}${r.truncado ? "+" : ""} archivo(s) huérfano(s) (${mb} MB). Revísalos con \`pnpm reconciliar-medios\`; para que se borren solos: MEDIA_RECONCILE_AUTO=on`);
    }
  } catch (err) {
    // Si el listado o la base fallan, no se borró nada (la corrida aborta antes de borrar).
    console.error("[medios] la reconciliación de huérfanos falló:", err instanceof Error ? err.message : err);
  }
}

/** Una tanda del reintento proactivo de adjuntos entrantes pendientes o fallidos (Hallazgo J). */
export async function tickAdjuntosPendientes(now = new Date()): Promise<void> {
  const s = state();
  if (s.retrying) return;
  s.retrying = true;
  try {
    const r = await reintentarAdjuntosPendientes({ now });
    if (r.reintentados > 0) {
      console.log(
        `[medios] adjuntos entrantes pendientes: ${r.recuperados} recuperado(s) de ${r.reintentados} reintentado(s)${r.detenido ? " (se detuvo la tanda: el almacenamiento o Meta siguen fallando)" : ""}`
      );
    }
  } catch (err) {
    console.error("[medios] el reintento de adjuntos pendientes falló:", err instanceof Error ? err.message : err);
  } finally {
    s.retrying = false;
  }
}

export function startMediaMaintenance(): void {
  const s = state();
  if (!s.timer) {
    s.timer = setInterval(() => void tickMediaMaintenance(), INTERVAL_MS);
    s.timer.unref?.();
  }
  if (!s.retryTimer) {
    s.retryTimer = setInterval(() => void tickAdjuntosPendientes(), REINTENTO_CADA_MS);
    s.retryTimer.unref?.();
  }
}
