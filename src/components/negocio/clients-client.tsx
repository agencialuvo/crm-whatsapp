"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Eye, History, Pencil, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch, describeError } from "@/components/negocio/api";
import { PageSizeSelect } from "@/components/negocio/page-size-select";
import { useTablePageSize } from "@/components/negocio/use-page-size";
import { BulkImportDialog } from "@/components/negocio/bulk-import-dialog";
import { ClientDialog } from "@/components/negocio/client-dialog";
import { ClientHistoryDialog } from "@/components/negocio/client-history-dialog";
import { ConfirmDialog } from "@/components/negocio/modal";
import { birthdayLabel, dateNumeric, formatPeruPhone, money } from "@/lib/salon/format";
import type { SalonClientDto } from "@/lib/salon/types";

/** Clientes por página por defecto; cada persona puede elegir otro número. */
const DEFAULT_PAGE_SIZE = 10;

type Listing = { clients: SalonClientDto[]; truncated: boolean };

/**
 * Módulo SALON — los clientes del salón (solo dueño/administrador).
 *
 * Un contacto es cliente desde su primera compra en Caja. La lista muestra
 * cuánto ha venido y cuánto ha invertido, de 10 en 10, con un contador de
 * registros. Se pueden marcar varios para eliminarlos juntos; el número de
 * «Visitas» abre la línea de tiempo de ese cliente. Las fechas se cuentan en la
 * zona del negocio.
 */
export function ClientsClient({
  currency,
  timezone,
  today,
}: {
  currency: string;
  timezone: string;
  today: string;
}) {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useTablePageSize("clientes", DEFAULT_PAGE_SIZE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRemoving, setBulkRemoving] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  // `undefined`: cerrado · `null`: alta de un cliente nuevo · texto: la ficha de ese cliente.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);
  // El ojo abre la ficha en solo lectura; el lápiz, directo en edición.
  const [openView, setOpenView] = useState(false);
  const [removing, setRemoving] = useState<SalonClientDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const load = useCallback(async (q: string) => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<Listing>(
        `/api/negocio/clientes${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`,
        { signal: ctrl.signal }
      );
      if (ctrl.signal.aborted) return;
      setData(res);
      // Lo marcado que ya no está en la lista (eliminado, fuera de la búsqueda) se suelta.
      setSelected((prev) => {
        const ids = new Set(res.clients.map((x) => x.id));
        const keep = [...prev].filter((id) => ids.has(id));
        return keep.length === prev.size ? prev : new Set(keep);
      });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(describeError(err));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  // La búsqueda espera un instante para no pedir en cada tecla.
  useEffect(() => {
    const t = setTimeout(() => void load(query), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, load]);

  useEffect(() => () => ctrlRef.current?.abort(), []);

  const clients = useMemo(() => data?.clients ?? [], [data]);
  const pages = Math.max(1, Math.ceil(clients.length / pageSize));
  const current = Math.min(page, pages);
  const rows = useMemo(
    () => clients.slice((current - 1) * pageSize, current * pageSize),
    [clients, current, pageSize]
  );
  const allOnPage = rows.length > 0 && rows.every((x) => selected.has(x.id));
  const someOnPage = rows.some((x) => selected.has(x.id));
  const masterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (masterRef.current) masterRef.current.indeterminate = someOnPage && !allOnPage;
  }, [someOnPage, allOnPage]);

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function togglePage() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const x of rows) {
        if (allOnPage) next.delete(x.id);
        else next.add(x.id);
      }
      return next;
    });
  }

  async function removeSelected() {
    const res = await apiFetch<{ removed: number; deleted: number; kept: number }>(
      "/api/negocio/clientes/eliminar",
      { method: "POST", json: { ids: [...selected] } }
    );
    setSelected(new Set());
    const parts: string[] = [];
    if (res.kept > 0)
      parts.push(
        `${res.kept} con historial ya no ${res.kept === 1 ? "aparece" : "aparecen"} en Clientes (su contacto y sus ventas se conservan)`
      );
    if (res.deleted > 0)
      parts.push(`${res.deleted} sin historial ${res.deleted === 1 ? "se eliminó" : "se eliminaron"} por completo`);
    setNotice(parts.length > 0 ? `${parts.join("; ")}.` : "No había nada que eliminar.");
    await load(query);
  }

  async function removeClient(c: SalonClientDto) {
    await apiFetch(`/api/negocio/clientes/${c.id}`, { method: "DELETE" });
    setNotice(`${c.name} ya no está en Clientes. Su contacto y sus ventas se conservan.`);
    await load(query);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Buscar por nombre o celular"
            aria-label="Buscar clientes"
            maxLength={80}
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setBulkOpen(true)}>
            <Upload className="h-4 w-4" aria-hidden />
            Carga masiva
          </Button>
          <Button
            onClick={() => {
              setOpenView(false);
              setOpenId(null);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Nuevo cliente
          </Button>
        </div>
      </div>

      {data && clients.length > 0 && (
        <p className="text-xs text-text-3" aria-live="polite">
          Mostrando {rows.length} de {clients.length} cliente{clients.length === 1 ? "" : "s"}
          {data.truncated ? " (hay más: afina con la búsqueda)" : ""}
        </p>
      )}

      {selected.size > 0 && (
        <div
          role="region"
          aria-label="Acciones sobre los clientes seleccionados"
          className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-2 rounded-md border bg-popover px-3 py-2 shadow-pop"
        >
          <p className="text-sm font-medium" aria-live="polite">
            {selected.size} seleccionado{selected.size === 1 ? "" : "s"}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              <X className="h-4 w-4" aria-hidden />
              Quitar selección
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setBulkRemoving(true)}>
              <Trash2 className="h-4 w-4" aria-hidden />
              Eliminar seleccionados
            </Button>
          </div>
        </div>
      )}

      {notice && (
        <p
          role="status"
          className="rounded-md border border-success-soft bg-success-tint px-3 py-2 text-sm text-success-text"
        >
          {notice}
        </p>
      )}

      {error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-danger-soft bg-danger-tint px-3 py-2.5 text-sm text-danger-text"
        >
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void load(query)}>
            Reintentar
          </Button>
        </div>
      ) : loading && data === null ? (
        <div className="space-y-2" aria-busy aria-label="Cargando clientes">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-md bg-subtle" />
          ))}
        </div>
      ) : clients.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-text-2">
          {query.trim()
            ? "Ningún cliente coincide con la búsqueda."
            : "Aún no hay clientes. Crea uno con «Nuevo cliente»; también pasa a serlo quien realiza su primera compra en Caja."}
        </p>
      ) : (
        <>
          {data?.truncated && (
            <p className="rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
              Hay más clientes de los que se muestran. Usa la búsqueda para encontrar a uno en
              concreto.
            </p>
          )}
          {/* `relative`: contiene el `sr-only` de la cabecera dentro del scroll. */}
          <div
            className={`relative overflow-x-auto rounded-md border ${loading ? "opacity-60" : ""}`}
            aria-busy={loading}
          >
            <table className="w-full min-w-[800px] text-sm">
              <thead>
                <tr className="border-b bg-subtle text-left text-xs font-semibold text-text-2">
                  <th scope="col" className="w-10 px-3 py-2">
                    <input
                      ref={masterRef}
                      type="checkbox"
                      checked={allOnPage}
                      onChange={togglePage}
                      aria-label="Seleccionar todos los clientes de esta página"
                      className="h-4 w-4 accent-primary"
                    />
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Nombre
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Celular
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Cumpleaños
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    Visitas
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Última visita
                  </th>
                  <th scope="col" className="px-4 py-2 text-right">
                    Total invertido
                  </th>
                  <th scope="col" className="px-2 py-2">
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr
                    key={c.id}
                    className={`border-b last:border-0 hover:bg-row-hover ${selected.has(c.id) ? "bg-brand-tint" : ""}`}
                  >
                    <td className="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggleOne(c.id)}
                        aria-label={`Seleccionar a ${c.name}`}
                        className="h-4 w-4 accent-primary"
                      />
                    </td>
                    <td className="max-w-[14rem] px-2 py-2">
                      <button
                        type="button"
                        onClick={() => {
                          setOpenView(true);
                          setOpenId(c.id);
                        }}
                        className="block max-w-full truncate rounded-sm text-left font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {c.name}
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-text-2">{formatPeruPhone(c.phone)}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-text-2">
                      {birthdayLabel(c.birthdayDay, c.birthdayMonth)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {c.visits > 0 ? (
                        <span className="group relative inline-block">
                          <button
                            type="button"
                            onClick={() => setHistoryId(c.id)}
                            aria-label={`Ver historial de visitas de ${c.name} (${c.visits})`}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-brand-soft bg-brand-tint px-2 py-0.5 text-xs font-semibold tabular-nums text-brand-text transition-colors hover:bg-brand-soft hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <History className="h-3 w-3" aria-hidden />
                            {c.visits}
                          </button>
                          {/* Etiqueta flotante: aparece al pasar el cursor o enfocar con el teclado. */}
                          <span
                            role="tooltip"
                            className="pointer-events-none absolute right-full top-1/2 z-20 mr-2 hidden -translate-y-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs font-medium text-foreground shadow-pop group-focus-within:block group-hover:block"
                          >
                            Ver historial de visitas
                          </span>
                        </span>
                      ) : (
                        c.visits
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-text-2">
                      {c.lastVisitAt ? dateNumeric(c.lastVisitAt, timezone) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums">
                      {money(c.totalCents, currency)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Ver la información de ${c.name}`}
                        onClick={() => {
                          setOpenView(true);
                          setOpenId(c.id);
                        }}
                      >
                        <Eye className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Editar a ${c.name}`}
                        onClick={() => {
                          setOpenView(false);
                          setOpenId(c.id);
                        }}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Eliminar a ${c.name}`}
                        onClick={() => setRemoving(c)}
                      >
                        <Trash2 className="h-4 w-4 text-danger-text" aria-hidden />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <PageSizeSelect
                value={pageSize}
                onChange={(n) => {
                  setPageSize(n);
                  setPage(1);
                }}
              />
              {pages > 1 && (
                <p className="text-xs text-text-3">
                  Página {current} de {pages}
                </p>
              )}
            </div>
            {pages > 1 && (
            <nav aria-label="Paginación de clientes">
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(current - 1)}
                  disabled={current <= 1}
                  aria-label="Página anterior"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden />
                  Anterior
                </Button>
                {pageWindow(current, pages).map((n, i) =>
                  n === null ? (
                    <span key={`gap${i}`} className="px-1 text-text-3" aria-hidden>
                      …
                    </span>
                  ) : (
                    <Button
                      key={n}
                      variant={n === current ? "default" : "ghost"}
                      size="sm"
                      onClick={() => setPage(n)}
                      aria-label={`Página ${n}`}
                      aria-current={n === current ? "page" : undefined}
                      className="min-w-8 tabular-nums"
                    >
                      {n}
                    </Button>
                  )
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(current + 1)}
                  disabled={current >= pages}
                  aria-label="Página siguiente"
                >
                  Siguiente
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </nav>
            )}
          </div>
        </>
      )}

      {bulkOpen && (
        <BulkImportDialog module="clientes" onClose={() => setBulkOpen(false)} onImported={() => void load(query)} />
      )}

      {openId !== undefined && (
        <ClientDialog
          clientId={openId}
          view={openView}
          currency={currency}
          timezone={timezone}
          today={today}
          onClose={() => setOpenId(undefined)}
          onChanged={() => void load(query)}
        />
      )}

      {historyId && (
        <ClientHistoryDialog
          clientId={historyId}
          currency={currency}
          timezone={timezone}
          onClose={() => setHistoryId(null)}
        />
      )}

      {bulkRemoving && (
        <ConfirmDialog
          title="Eliminar clientes"
          message={
            <div className="space-y-2">
              <p>
                ¿Eliminar {selected.size} cliente{selected.size === 1 ? "" : "s"}?
              </p>
              <p>
                Los que tienen historial (atenciones, conversaciones o citas) solo dejan de
                aparecer en Clientes: su contacto y sus ventas se conservan. Los que no tienen
                nada se eliminan por completo y no se puede deshacer.
              </p>
            </div>
          }
          confirmLabel={`Eliminar ${selected.size} cliente${selected.size === 1 ? "" : "s"}`}
          onConfirm={removeSelected}
          onClose={() => setBulkRemoving(false)}
        />
      )}

      {removing && (
        <ConfirmDialog
          title="Eliminar cliente"
          message={
            <p>
              <strong>{removing.name}</strong> dejará de aparecer en Clientes. Su contacto y sus
              ventas se conservan; si vuelve a comprar en Caja, será cliente otra vez.
            </p>
          }
          confirmLabel="Eliminar cliente"
          onConfirm={() => removeClient(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

/** Números de página a mostrar: primera, última y las vecinas de la actual (`null` = hueco). */
function pageWindow(current: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, current - 1, current, current + 1]);
  const list = [...keep].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  list.forEach((n, i) => {
    if (i > 0 && n - list[i - 1]! > 1) out.push(null);
    out.push(n);
  });
  return out;
}
