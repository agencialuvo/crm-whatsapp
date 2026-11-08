"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTablePagination, DataTableToolbar } from "@/components/ui/data-table-pagination";
import { EmptyState } from "@/components/ui/empty-state";
import { useTablePageSize } from "@/components/ui/use-table-page-size";
import { LogDetailDialog } from "@/components/automatizaciones/log-detail-dialog";
import { apiFetch, describeError } from "@/components/negocio/api";
import {
  LOG_FILTERS,
  MAX_LOG_ROWS,
  describeLog,
  formatWhen,
  logStatusLabel,
  logStatusTone,
  logStepTitle,
  type LogDto,
  type LogsPageDto,
} from "@/lib/automation-monitor-dto";
import type { LogStatusFilter } from "@/lib/automation-schemas";
import { DEFAULT_PAGE_SIZE, rowsPerPage } from "@/lib/pagination";
import { cn } from "@/lib/utils";

type Filter = LogStatusFilter | "all";

const NOUN = { one: "ejecución", other: "ejecuciones" };

/**
 * Automatizaciones — historial de ejecuciones de un flujo: quién recibió qué, cuándo y cómo terminó.
 * Se filtra por estado, se pagina desde el servidor y cada línea abre su detalle (la foto del paso,
 * el mensaje enviado y su ID en WhatsApp, o el error exacto).
 *
 * `refreshKey` cambia cuando la persona pide actualizar: vuelve a pedir la página que está viendo.
 */
export function HistoryPanel({
  flowId,
  refreshKey,
  onLoadingChange,
}: {
  flowId: string;
  refreshKey: number;
  onLoadingChange?: (loading: boolean) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [pageSize, setPageSize] = useTablePageSize("automatizaciones-historial", DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(0); // desde 0 aquí, desde 1 en el pie
  const [data, setData] = useState<LogsPageDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<LogDto | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const loadingCb = useRef(onLoadingChange);
  loadingCb.current = onLoadingChange;

  // «Todos» pide lo máximo que el servidor entrega por consulta; con más, se pagina de a tanto.
  const limit = Math.min(rowsPerPage(pageSize), MAX_LOG_ROWS);

  const load = useCallback(
    async (status: Filter, offset: number, rows: number) => {
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setLoading(true);
      loadingCb.current?.(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ limit: String(rows), offset: String(offset) });
        if (status !== "all") qs.set("status", status);
        const res = await apiFetch<LogsPageDto>(`/api/automations/${flowId}/logs?${qs}`, { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        // Si el historial se encogió y la página ya no existe, se vuelve a la última que sí.
        if (res.logs.length === 0 && res.total > 0 && offset > 0) {
          setPage(Math.max(0, Math.ceil(res.total / rows) - 1));
          return;
        }
        setData(res);
      } catch (err) {
        if (!ctrl.signal.aborted) setError(describeError(err));
      } finally {
        if (!ctrl.signal.aborted) {
          setLoading(false);
          loadingCb.current?.(false);
        }
      }
    },
    [flowId]
  );

  useEffect(() => {
    void load(filter, page * limit, limit);
    return () => ctrlRef.current?.abort();
  }, [filter, page, limit, load, refreshKey]);

  const total = data?.total ?? 0;

  return (
    <section aria-label="Historial de ejecuciones" className="space-y-3">
      <div role="tablist" aria-label="Filtrar por estado" className="flex flex-wrap gap-1.5">
        {LOG_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => {
              setFilter(f.value);
              setPage(0);
            }}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              filter === f.value
                ? "border-transparent bg-brand text-brand-fg"
                : "border-border-strong bg-card text-text-2 hover:bg-subtle"
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-danger-soft bg-danger-tint p-4 text-sm text-danger-text">
          <p>{error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void load(filter, page * limit, limit)}>
            Reintentar
          </Button>
        </div>
      )}

      {!data && !error ? (
        <div className="space-y-2" aria-busy aria-label="Cargando el historial">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg border bg-subtle" />
          ))}
        </div>
      ) : data && data.total === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-card py-8">
          <EmptyState
            icon={History}
            title={filter === "all" ? "Este flujo aún no se ha ejecutado" : "Ninguna ejecución con este estado"}
            description={
              filter === "all"
                ? "Cuando se active para un cliente, cada paso que se ejecute quedará registrado aquí."
                : "Prueba con otro filtro, o quítalo para ver todo el historial."
            }
            action={
              filter !== "all" ? (
                <Button variant="outline" onClick={() => setFilter("all")}>
                  Ver todas
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : data ? (
        <>
          <DataTableToolbar
            page={page + 1}
            pageSize={pageSize}
            total={total}
            maxPerPage={MAX_LOG_ROWS}
            disabled={loading}
            noun={NOUN}
            onPageSizeChange={(n) => {
              setPageSize(n);
              setPage(0);
            }}
          />
          <div
            className={cn(
              "relative overflow-x-auto rounded-lg border border-border-strong bg-card shadow-sm transition-opacity",
              loading && "opacity-60"
            )}
          >
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b bg-subtle text-left text-xs font-semibold text-text-2">
                  <th scope="col" className="px-4 py-2.5">Fecha</th>
                  <th scope="col" className="px-4 py-2.5">Contacto</th>
                  <th scope="col" className="px-4 py-2.5">Paso</th>
                  <th scope="col" className="px-4 py-2.5">Estado</th>
                  <th scope="col" className="px-4 py-2.5">Detalle</th>
                  <th scope="col" className="px-4 py-2.5"><span className="sr-only">Ver</span></th>
                </tr>
              </thead>
              <tbody>
                {data.logs.map((log) => {
                  const d = describeLog(log);
                  return (
                    <tr
                      key={log.id}
                      className="cursor-pointer border-b last:border-0 hover:bg-subtle"
                      onClick={() => setOpen(log)}
                    >
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums">{formatWhen(log.executedAt)}</td>
                      <td className="px-4 py-3">
                        <p className="font-medium">{log.contact.name}</p>
                        {log.contact.phone && <p className="text-xs text-text-3">{log.contact.phone}</p>}
                      </td>
                      <td className="px-4 py-3">{logStepTitle(log)}</td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <Badge variant={logStatusTone(log.status)}>{logStatusLabel(log.status)}</Badge>
                      </td>
                      <td className="max-w-[16rem] px-4 py-3">
                        {d.error ? (
                          <p className="truncate text-xs text-danger-text" title={d.error}>{d.error}</p>
                        ) : (
                          <span className="text-text-3">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Ver el detalle de ${log.contact.name}, ${formatWhen(log.executedAt)}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpen(log);
                          }}
                        >
                          <ChevronRight className="h-4 w-4" aria-hidden />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* El servidor entrega el historial por tramos (`page` va desde 0 aquí, desde 1 en el pie). */}
          <DataTablePagination
            page={page + 1}
            pageSize={pageSize}
            total={total}
            maxPerPage={MAX_LOG_ROWS}
            disabled={loading}
            noun={NOUN}
            label="Paginación del historial"
            onPageChange={(n) => setPage(n - 1)}
            onPageSizeChange={(n) => {
              setPageSize(n);
              setPage(0);
            }}
          />
        </>
      ) : null}

      {open && <LogDetailDialog log={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
