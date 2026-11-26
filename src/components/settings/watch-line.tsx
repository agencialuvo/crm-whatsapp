import { watchStatusText, type WatchStatus } from "@/lib/google-watch-status";

/** Mejora 4: cómo llegan los cambios del calendario (avisos al instante o cada 5 min). Nada si no aplica. */
export function WatchLine({ status }: { status: WatchStatus | null }) {
  const line = watchStatusText(status);
  if (!line) return null;
  const tone = line.tone === "ok" ? "text-success-text" : line.tone === "warn" ? "text-warning-text" : "text-text-3";
  return <p className={`text-xs ${tone}`}>{line.text}</p>;
}
