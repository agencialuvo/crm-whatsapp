"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * 016/039 — El registro de conversiones que se le reportaron a Meta. Es depuración: va en un acordeón
 * CERRADO. La lista se pide al entrar (es la misma consulta de siempre) para que el resumen de la cabecera
 * ya diga si algo falló sin tener que abrirlo.
 */

type ActivityRow = {
  id: string;
  eventName: string;
  contactName: string | null;
  adHeadline: string | null;
  status: "pending" | "sent" | "failed" | "skipped";
  at: string;
  fbTraceId: string | null;
  error: string | null;
};

const STATUS_LABEL: Record<ActivityRow["status"], string> = {
  sent: "Enviado",
  failed: "Falló",
  skipped: "Omitido",
  pending: "En curso",
};

const STATUS_VARIANT: Record<ActivityRow["status"], "success" | "destructive" | "secondary"> = {
  sent: "success",
  failed: "destructive",
  skipped: "secondary",
  pending: "secondary",
};

/** Qué significa cada evento, en el idioma del negocio y no en el de Meta. */
const EVENT_LABEL: Record<string, string> = {
  QualifiedLead: "Lead calificado",
  Purchase: "Venta",
};

function resumen(rows: ActivityRow[]): string {
  if (rows.length === 0) return "Sin conversiones todavía";
  const n = (s: ActivityRow["status"]) => rows.filter((r) => r.status === s).length;
  const partes = [`${n("sent")} enviadas`];
  if (n("failed") > 0) partes.push(`${n("failed")} fallaron`);
  if (n("skipped") > 0) partes.push(`${n("skipped")} omitidas`);
  return partes.join(" · ");
}

export function CapiEventsLog() {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/settings/capi/events").catch(() => null);
    setLoading(false);
    if (!res?.ok) return setRows([]);
    const data = (await res.json()) as { events: ActivityRow[] };
    setRows(data.events);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <details className="group rounded-md border bg-card" data-capi-log>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span>Ver registro de eventos de conversión</span>
        <span className="text-xs font-normal text-muted-foreground">
          {rows === null ? "Cargando…" : resumen(rows)}
        </span>
      </summary>
      <div className="space-y-3 border-t px-3 py-3">
        <p className="text-xs text-muted-foreground">
          Lo último que se le reportó a Meta. Si algo no salió, aquí dice por qué.
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? "Actualizando…" : "Actualizar"}
        </Button>
        {rows === null ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Todavía no hay conversiones. Aparecerán cuando un lead que llegó por un anuncio avance de etapa.
          </p>
        ) : (
          <ul className="divide-y text-sm">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {EVENT_LABEL[row.eventName] ?? row.eventName}
                    <span className="font-normal text-muted-foreground"> · {row.contactName ?? "—"}</span>
                  </p>
                  {row.adHeadline ? <p className="truncate text-xs text-muted-foreground">{row.adHeadline}</p> : null}
                  <p className="text-xs text-muted-foreground">{row.error ?? row.fbTraceId ?? "—"}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={STATUS_VARIANT[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(row.at).toLocaleString("es-MX")}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
