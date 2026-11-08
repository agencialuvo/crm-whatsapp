"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, RefreshCw, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch, describeError } from "@/components/negocio/api";
import { formatWhen, relativeWhen, type StatsDto } from "@/lib/automation-monitor-dto";
import { cn } from "@/lib/utils";

/**
 * Estado del motor de un flujo (`flowId`) o de toda la organización (sin `flowId`). El estado vive en el
 * hook para que quien lo usa pueda refrescarlo junto con otras cosas (el historial) con un solo botón.
 */
export function useAutomationStats(flowId: string | null) {
  const [stats, setStats] = useState<StatsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ stats: StatsDto }>(
        flowId ? `/api/automations/${flowId}/stats` : "/api/automations/stats"
      );
      if (mine !== seq.current) return; // llegó una respuesta más nueva: esta ya no vale
      setStats(res.stats);
      setUpdatedAt(new Date());
    } catch (err) {
      if (mine === seq.current) setError(describeError(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [flowId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { stats, error, loading, updatedAt, reload };
}

type Tone = "neutral" | "success" | "danger" | "warning";

const TONES: Record<Tone, { box: string; icon: string; value: string }> = {
  neutral: { box: "border-border-strong bg-card", icon: "bg-subtle text-text-2", value: "text-foreground" },
  success: { box: "border-border-strong bg-card", icon: "bg-success-tint text-success-text", value: "text-foreground" },
  // Los fallos son los únicos que cambian el color de TODA la tarjeta cuando hay alguno: no se pueden pasar por alto.
  danger: { box: "border-danger-soft bg-danger-tint", icon: "bg-card text-danger-text", value: "text-danger-text" },
  warning: { box: "border-border-strong bg-card", icon: "bg-warning-tint text-warning-text", value: "text-foreground" },
};

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number | null;
  hint: string;
  icon: typeof Clock;
  tone: Tone;
}) {
  const t = TONES[tone];
  return (
    <div className={cn("rounded-lg border p-4 shadow-sm", t.box)}>
      <div className="flex items-center gap-2.5">
        <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md", t.icon)}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <p className="text-xs font-semibold text-text-2">{label}</p>
      </div>
      <p className={cn("mt-3 text-2xl font-bold tabular-nums tracking-tight", t.value)}>
        {value === null ? <span className="text-text-3">—</span> : value.toLocaleString("es")}
      </p>
      <p className="mt-1 text-xs text-text-3">{hint}</p>
    </div>
  );
}

/** El botón «Actualizar» con la hora de la última consulta. */
export function RefreshButton({
  loading,
  updatedAt,
  onClick,
}: {
  loading: boolean;
  updatedAt: Date | null;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      {updatedAt && (
        <span className="hidden text-xs text-text-3 sm:inline">
          Actualizado {updatedAt.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
      )}
      <Button variant="outline" size="sm" onClick={onClick} disabled={loading}>
        <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} aria-hidden />
        Actualizar estado
      </Button>
    </div>
  );
}

/** Las cuatro tarjetas: en cola, enviados, fallidos y omitidos. */
export function StatsPanel({
  stats,
  error,
  loading,
  onRetry,
  scope,
}: {
  stats: StatsDto | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  /** «de este flujo» / «de tus flujos»: para que se lea de qué es el número. */
  scope: string;
}) {
  if (error && !stats) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-danger-soft bg-danger-tint p-4 text-sm text-danger-text"
      >
        <p>{error}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          Reintentar
        </Button>
      </div>
    );
  }

  const s = stats?.summary ?? null;
  const q = stats?.queue ?? null;
  const e = stats?.executions ?? null;
  const failed = s?.failed ?? 0;

  return (
    <section aria-label={`Estado del motor ${scope}`} aria-busy={loading}>
      {error && (
        <p role="alert" className="mb-3 rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text">
          No se pudo actualizar: {error}
        </p>
      )}
      <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", loading && stats && "opacity-70")}>
        <MetricCard
          label="En cola"
          value={s?.pending ?? null}
          icon={Clock}
          tone="neutral"
          hint={
            q
              ? q.processing > 0
                ? `${q.processing} en proceso ahora`
                : q.nextScheduledFor
                  ? `Próximo ${relativeWhen(q.nextScheduledFor)}`
                  : "Nada programado"
              : "Cargando…"
          }
        />
        <MetricCard
          label="Exitosos"
          value={s?.success ?? null}
          icon={CheckCircle2}
          tone="success"
          hint={e ? (e.lastExecutedAt ? `Último ${formatWhen(e.lastExecutedAt)}` : "Aún no se ha enviado nada") : "Cargando…"}
        />
        <MetricCard
          label="Fallidos"
          value={s?.failed ?? null}
          icon={AlertTriangle}
          tone={failed > 0 ? "danger" : "neutral"}
          hint={failed > 0 ? "Agotaron sus reintentos: revisa el historial" : "Ninguna tarea se rindió"}
        />
        <MetricCard
          label="Omitidos"
          value={s?.skipped ?? null}
          icon={SkipForward}
          tone="warning"
          hint={e ? `${e.skippedRateLimit} por frecuencia · ${e.skippedOptOut} por baja` : "Cargando…"}
        />
      </div>
    </section>
  );
}
