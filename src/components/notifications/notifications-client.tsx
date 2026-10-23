"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useEvents } from "@/components/use-events";
import { dateTimeLabel } from "@/lib/salon/format";
import {
  NOTIFICATION_CATEGORY_LABELS,
  NOTIFICATION_FILTERS,
  NOTIFICATION_FILTER_LABELS,
  timeAgo,
  type NotificationDto,
  type NotificationFilter,
  type NotificationListDto,
} from "@/lib/notifications";
import { cn } from "@/lib/utils";

const PAGE = 20;

/**
 * `/notificaciones` — todo lo que ha pasado en el negocio, con filtros (Todas, No
 * leídas, Citas, Caja/Ventas, WhatsApp). Tocar una la marca como leída y abre el
 * recurso relacionado (la cita o la venta). Se mantiene al día con el bus de
 * eventos: un aviso nuevo aparece sin recargar.
 */
export function NotificationsClient({ timezone }: { timezone: string }) {
  const router = useRouter();
  const [filter, setFilter] = useState<NotificationFilter>("todas");
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [unread, setUnread] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const load = useCallback(async (f: NotificationFilter, silent: boolean) => {
    const id = ++seq.current;
    if (!silent) setLoading(true);
    const res = await fetch(`/api/notificaciones?filtro=${f}&limit=${PAGE}`).catch(() => null);
    if (id !== seq.current) return;
    if (!res?.ok) {
      if (!silent) setError("No se pudieron cargar las notificaciones.");
      setLoading(false);
      return;
    }
    const data = (await res.json()) as NotificationListDto;
    setItems(data.items);
    setUnread(data.unread);
    setHasMore(data.hasMore);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(filter, false);
  }, [filter, load]);

  const refresh = useCallback(() => void load(filterRef.current, true), [load]);
  useEvents({ onNotificationNew: refresh, onReconnect: refresh });

  async function more() {
    const res = await fetch(`/api/notificaciones?filtro=${filter}&limit=${PAGE}&offset=${items.length}`).catch(
      () => null
    );
    if (!res?.ok) return;
    const data = (await res.json()) as NotificationListDto;
    setItems((cur) => [...cur, ...data.items.filter((n) => !cur.some((c) => c.id === n.id))]);
    setHasMore(data.hasMore);
    setUnread(data.unread);
  }

  async function open(n: NotificationDto) {
    if (!n.isRead) {
      setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
      setUnread((u) => Math.max(0, u - 1));
      await fetch(`/api/notificaciones/${n.id}`, { method: "PATCH" }).catch(() => null);
    }
    if (n.link) router.push(n.link);
  }

  async function markAll() {
    setItems((cur) => cur.map((x) => ({ ...x, isRead: true })));
    setUnread(0);
    await fetch("/api/notificaciones/leer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => null);
    void load(filter, true);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Filtros" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5">
          {NOTIFICATION_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={f === filter}
              onClick={() => setFilter(f)}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-[13px] font-semibold transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                f === filter
                  ? "border-brand-soft bg-brand-tint text-brand-text"
                  : "text-text-2 hover:bg-accent hover:text-foreground"
              )}
            >
              {NOTIFICATION_FILTER_LABELS[f]}
              {f === "no_leidas" && unread > 0 && (
                <span className="ml-1.5 rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-bold text-white">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </button>
          ))}
        </nav>
        <Button variant="outline" size="sm" onClick={() => void markAll()} disabled={unread === 0}>
          <CheckCheck className="h-4 w-4" aria-hidden />
          Marcar todas como leídas
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg border border-danger-soft bg-danger-tint p-4 text-sm text-danger-text">
          <p>{error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void load(filter, false)}>
            Reintentar
          </Button>
        </div>
      ) : loading ? (
        <div className="space-y-2" aria-busy aria-label="Cargando">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg border bg-subtle" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-card py-8">
          <EmptyState
            icon={Bell}
            title={filter === "no_leidas" ? "Estás al día" : "Sin notificaciones"}
            description={
              filter === "no_leidas"
                ? "No tienes notificaciones sin leer."
                : "Aquí aparecerán las citas, las ventas y los contactos nuevos."
            }
          />
        </div>
      ) : (
        <>
          <ul className="divide-y overflow-hidden rounded-lg border bg-card">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => void open(n)}
                  className={cn(
                    "flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-row-hover focus-visible:bg-row-hover focus-visible:outline-none",
                    !n.isRead && "bg-brand-tint/50"
                  )}
                >
                  <span
                    aria-hidden
                    className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", n.isRead ? "bg-transparent" : "bg-brand")}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className={cn("text-sm", n.isRead ? "font-medium" : "font-semibold")}>{n.title}</span>
                      <span className="text-xs text-text-3" title={dateTimeLabel(n.createdAt, timezone)}>
                        {timeAgo(n.createdAt)}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-sm text-text-2">{n.message}</span>
                    <span className="mt-1 inline-block rounded-full border bg-background px-2 py-0.5 text-[11px] font-medium text-text-2">
                      {NOTIFICATION_CATEGORY_LABELS[n.category]}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {hasMore && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => void more()}>
                Mostrar más
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
