"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { useEvents } from "@/components/use-events";
import {
  NOTIFICATION_CATEGORY_LABELS,
  timeAgo,
  type NotificationDto,
  type NotificationListDto,
} from "@/lib/notifications";
import { cn } from "@/lib/utils";

/** La campanita se refresca sola cada minuto aunque no llegue ningún evento. */
const POLL_MS = 60_000;

/**
 * La campanita de la barra superior: cuántas notificaciones siguen sin leer y, al
 * tocarla, un panel con las 5 más recientes. Tocar una la marca como leída y lleva
 * a la cita o la venta; «Marcar todas» las limpia; «Ver todas» abre
 * `/notificaciones`. Se cierra con Escape, con la X o tocando fuera.
 *
 * Se mantiene al día con el bus de eventos (un aviso nuevo aparece sin recargar),
 * con un respaldo cada minuto y al volver a la pestaña.
 */
export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<NotificationListDto | null>(null);
  const [failed, setFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/notificaciones?limit=5").catch(() => null);
    if (!res?.ok) {
      setFailed(true);
      return;
    }
    setData((await res.json().catch(() => null)) as NotificationListDto | null);
    setFailed(false);
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  useEvents({ onNotificationNew: () => void load(), onReconnect: () => void load() });

  // Cerrar: Escape o tocar fuera del panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const unread = data?.unread ?? 0;

  async function openItem(n: NotificationDto) {
    setOpen(false);
    if (!n.isRead) {
      setData((d) =>
        d
          ? {
              ...d,
              unread: Math.max(0, d.unread - 1),
              items: d.items.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)),
            }
          : d
      );
      await fetch(`/api/notificaciones/${n.id}`, { method: "PATCH" }).catch(() => null);
    }
    if (n.link) router.push(n.link);
  }

  async function markAll() {
    setData((d) => (d ? { ...d, unread: 0, items: d.items.map((x) => ({ ...x, isRead: true })) } : d));
    await fetch("/api/notificaciones/leer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => null);
    void load();
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Notificaciones: ${unread} sin leer` : "Notificaciones"}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="relative rounded-md p-2 text-text-2 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bell className="h-5 w-5" strokeWidth={1.8} aria-hidden />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none text-white"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notificaciones recientes"
          className="absolute right-0 top-full z-50 mt-2 w-[22rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-pop"
        >
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
            <h3 className="text-sm font-bold">Notificaciones</h3>
            <button
              type="button"
              onClick={() => void markAll()}
              disabled={unread === 0}
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-xs font-medium text-brand-text hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden />
              Marcar todas como leídas
            </button>
          </div>

          {failed && !data ? (
            <p className="px-3 py-6 text-center text-sm text-text-2">No se pudieron cargar los avisos.</p>
          ) : !data ? (
            <div className="space-y-2 p-3" aria-busy aria-label="Cargando">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-md bg-subtle" />
              ))}
            </div>
          ) : data.items.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-text-2">Todavía no hay notificaciones.</p>
          ) : (
            <ul className="max-h-[60vh] divide-y overflow-y-auto">
              {data.items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => void openItem(n)}
                    className={cn(
                      "flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                      !n.isRead && "bg-brand-tint/60"
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.isRead ? "bg-transparent" : "bg-brand")}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className={cn("truncate text-sm", n.isRead ? "font-medium" : "font-semibold")}>
                          {n.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-text-3">{timeAgo(n.createdAt)}</span>
                      </span>
                      <span className="block truncate text-xs text-text-2">{n.message}</span>
                      <span className="mt-0.5 block text-[11px] text-text-3">
                        {NOTIFICATION_CATEGORY_LABELS[n.category]}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="border-t px-3 py-2 text-center">
            <Link
              href="/notificaciones"
              onClick={() => setOpen(false)}
              className="text-sm font-semibold text-brand-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Ver todas las notificaciones
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
