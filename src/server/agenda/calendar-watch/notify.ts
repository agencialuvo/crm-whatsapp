import { WATCH_MIN_GAP_MS } from "@/lib/google-watch";
import { busySyncInflight, requestBusySync, syncGoogleBusy } from "@/server/agenda/calendar-busy/sync";
import { staffBusySyncInflight, syncStaffBusy } from "@/server/agenda/staff-calendar/busy";

/**
 * Mejora 4 — Qué pasa cuando Google avisa que cambió un calendario: se lee OTRA VEZ esa fuente (el negocio o un
 * profesional) con la lectura de siempre. El aviso no trae datos y no se usa como dato.
 *
 * Ráfagas: Google manda varios avisos seguidos (editar una serie de eventos, mover varios). Por fuente, como
 * mucho UNA lectura cada 10 s: el primer aviso lee ya; los que llegan mientras se lee o dentro de los 10 s se
 * juntan en UNA lectura más al final. Un aviso que llega con una lectura en curso nunca se pierde: esa lectura
 * pudo empezar antes del cambio, así que se lee otra vez al terminar.
 *
 * El candado de la agenda y el anti-bucle son los de la lectura (Paso 4): publicar una cita en el calendario del
 * negocio genera un aviso, la lectura descarta ese evento (marca de Vocero / id conocido) y no escribe nada.
 */

type Slot = {
  lastStartAt: number;
  running: Promise<void> | null;
  pending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

const g = globalThis as unknown as { __voceroWatchSlots?: Map<string, Slot>; __voceroWatchGapMs?: number };
const slots = (): Map<string, Slot> => (g.__voceroWatchSlots ??= new Map());
const gap = (): number => g.__voceroWatchGapMs ?? WATCH_MIN_GAP_MS;

/** Solo pruebas: acorta (o restablece con `undefined`) el intervalo mínimo entre lecturas. */
export function setWatchMinGapForTests(ms: number | undefined): void {
  g.__voceroWatchGapMs = ms;
}

const keyOf = (organizationId: string, staffId: string | null) => `${organizationId}:${staffId ?? "-"}`;

/**
 * Un aviso válido de Google para esta fuente. `started` = se lee ya; `queued` = se junta con la lectura siguiente.
 * Nunca lanza.
 */
export function triggerSourceRead(organizationId: string, staffId: string | null, now = Date.now()): "started" | "queued" {
  const key = keyOf(organizationId, staffId);
  const s = slots().get(key) ?? { lastStartAt: 0, running: null, pending: false, timer: null };
  slots().set(key, s);
  if (s.running || s.timer) {
    s.pending = true;
    return "queued";
  }
  const wait = Math.max(0, s.lastStartAt + gap() - now);
  if (wait === 0) {
    start(key, organizationId, staffId);
    return "started";
  }
  s.timer = later(() => start(key, organizationId, staffId), wait);
  return "queued";
}

function start(key: string, organizationId: string, staffId: string | null): void {
  const s = slots().get(key);
  if (!s) return;
  s.timer = null;
  s.pending = false;
  s.lastStartAt = Date.now();
  s.running = readSource(organizationId, staffId)
    .catch((err) => console.warn(`[calendario] la lectura por aviso de Google falló: ${err instanceof Error ? err.message : err}`))
    .finally(() => {
      s.running = null;
      if (s.pending) {
        s.pending = false;
        const wait = Math.max(0, s.lastStartAt + gap() - Date.now());
        s.timer = later(() => start(key, organizationId, staffId), wait);
      }
    });
}

/** Lee esa fuente con una lectura que EMPIECE después del aviso (si había una en curso, se espera y se repite). */
async function readSource(organizationId: string, staffId: string | null): Promise<void> {
  if (staffId === null) {
    const running = busySyncInflight(organizationId);
    if (running) await running;
    // Vence ya (y reinicia los reintentos) y lanza la lectura; `syncGoogleBusy` devuelve esa misma para esperarla.
    await requestBusySync(organizationId, { ensureWatch: false });
    await syncGoogleBusy(organizationId);
    return;
  }
  const running = staffBusySyncInflight(organizationId, staffId);
  if (running) await running;
  await syncStaffBusy(organizationId, staffId);
}

function later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return t;
}

/** Pruebas y apagado: espera a que no quede ninguna lectura por aviso en curso ni pendiente. */
export async function waitForWatchReadsIdle(): Promise<void> {
  for (;;) {
    const all = [...slots().values()];
    const running = all.map((s) => s.running).filter((p): p is Promise<void> => p !== null);
    if (running.length > 0) {
      await Promise.allSettled(running);
      continue;
    }
    if (all.some((s) => s.timer !== null)) {
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }
    return;
  }
}

/** Pruebas: olvida el estado de las ráfagas. */
export function resetWatchReadsForTests(): void {
  for (const s of slots().values()) if (s.timer) clearTimeout(s.timer);
  slots().clear();
}
