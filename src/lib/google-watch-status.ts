/**
 * Mejora 4 — El estado de los avisos al instante tal como lo ve la pantalla (sin dependencias de servidor: lo
 * importan Ajustes y Equipo en el navegador). Las reglas de servidor viven en `google-watch.ts`.
 */

/** Lo que ve la pantalla: cómo llegan los cambios de UNA fuente. */
export type WatchStatus =
  | { status: "off" } // la bandera está apagada: no se muestra nada
  | { status: "unavailable"; reason: "no_https" } // encendida, pero Google no puede avisar a esta dirección
  | { status: "active" } // todos sus calendarios con canal activo
  | { status: "starting" } // pedido a Google o todavía sin pedir
  | { status: "failed"; error: string | null }; // Google lo rechazó: se lee cada 5 min y se reintenta

/** La línea que ve el dueño (null = no se muestra nada). Compartida por Ajustes y Equipo. */
export function watchStatusText(w: WatchStatus | null | undefined): { text: string; tone: "ok" | "muted" | "warn" } | null {
  if (!w) return null;
  switch (w.status) {
    case "off":
      return null;
    case "active":
      return { text: "Avisos al instante activos: los cambios del calendario llegan en segundos.", tone: "ok" };
    case "starting":
      return { text: "Activando los avisos al instante…", tone: "muted" };
    case "unavailable":
      return {
        text: "Los cambios se leen cada 5 min: los avisos al instante requieren que Vocero esté en https con un dominio público.",
        tone: "muted",
      };
    case "failed":
      return { text: "Google no aceptó los avisos al instante: se lee cada 5 min y se reintenta solo.", tone: "warn" };
  }
}

