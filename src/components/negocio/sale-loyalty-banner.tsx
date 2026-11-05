"use client";

import { useEffect, useState } from "react";
import { Stamp } from "lucide-react";
import { apiFetch } from "@/components/negocio/api";
import type { LoyaltyCardViewDto } from "@/lib/loyalty";
import { money } from "@/lib/salon/format";
import type { SaleRowDto } from "@/lib/salon/types";
import { cn } from "@/lib/utils";

/**
 * «Editar venta» — la tarjeta de fidelidad del cliente de la venta: su progreso (X/meta sellos) y qué pasa con
 * el sello de ESTA venta según el monto que se está escribiendo (si lo otorgó, si lo otorgará al guardar o si se
 * retirará). Así se corrige un servicio o un monto sin salir de la pantalla. Solo informa: al guardar, el servidor
 * deja el sello como corresponde.
 */
export function SaleLoyaltyBanner({
  sale,
  contactId,
  amountCents,
  currency,
}: {
  sale: SaleRowDto;
  /** El cliente que quedará en la venta (el actual o el que se eligió al cambiarlo). */
  contactId: string | null;
  /** El monto que se está escribiendo (`NaN` si está vacío o es inválido). */
  amountCents: number;
  currency: string;
}) {
  const [loaded, setLoaded] = useState<{ contactId: string; view: LoyaltyCardViewDto } | null>(null);
  useEffect(() => {
    if (!contactId) return;
    let alive = true;
    apiFetch<LoyaltyCardViewDto>(`/api/loyalty/card?contactId=${encodeURIComponent(contactId)}`)
      .then((view) => alive && setLoaded({ contactId, view }))
      .catch(() => alive && setLoaded(null));
    return () => {
      alive = false;
    };
  }, [contactId]);

  if (!contactId) {
    return (
      <p className="rounded-md border border-dashed px-3 py-2 text-xs text-text-3">
        Esta venta no tiene cliente asociado, así que no suma sellos. Elige un cliente para que pueda sumar.
      </p>
    );
  }
  const view = loaded?.contactId === contactId ? loaded.view : null;
  if (!view) return <p className="text-xs text-text-3">Cargando la tarjeta de fidelidad…</p>;

  const { settings } = view;
  const goal = Math.max(1, ...settings.milestones.map((m) => m.stamps));
  const current = view.card?.currentStamps ?? 0;
  const min = settings.minStampAmountCents;
  const qualifies = settings.enabled && Number.isFinite(amountCents) && amountCents >= min;
  const sameClient = contactId === sale.contactId;
  const minText = min > 0 ? `el mínimo de ${money(min, currency)}` : "el mínimo";

  // Qué decir del sello de esta venta, y con qué tono.
  let tone: "ok" | "warn" | "muted" = "muted";
  let text: string;
  if (!settings.enabled) {
    text = "El programa de fidelización está apagado: esta venta no suma sello.";
  } else if (sale.loyalty.blocked === "birthday") {
    text = "Esta venta lleva el descuento de cumpleaños: no suma sello.";
  } else if (sale.loyalty.blocked === "redeemed") {
    text = "Esta venta canjeó un premio de la tarjeta: no suma sello.";
  } else if (sale.loyalty.stamped && sameClient) {
    if (qualifies) {
      text = "Esta venta otorgó 1 sello y lo conservará con este monto.";
      tone = "ok";
    } else {
      text = `Con este monto ya no llega a ${minText}: al guardar se retirará el sello que dio.`;
      tone = "warn";
    }
  } else if (sale.loyalty.stamped) {
    text = qualifies
      ? "Al guardar, el sello de esta venta pasará al nuevo cliente."
      : `Con este monto no llega a ${minText}: al guardar se retirará el sello y no se pasará al nuevo cliente.`;
    tone = qualifies ? "ok" : "warn";
  } else if (qualifies) {
    text = "Con este monto, al guardar se otorgará 1 sello a este cliente.";
    tone = "ok";
  } else {
    text = `Esta venta no suma sello: no llega a ${minText}.`;
  }

  return (
    <section
      aria-label="Fidelidad del cliente"
      className={cn(
        "rounded-md border px-3 py-2.5",
        tone === "ok" && "border-success-soft bg-success-tint",
        tone === "warn" && "border-warning-soft bg-warning-tint",
        tone === "muted" && "bg-subtle/50"
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        <Stamp className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
        <span className="font-medium">{settings.cardTitle}</span>
        <span className="ml-auto tabular-nums text-text-2">
          Progreso actual: {Math.min(current, goal)}/{goal} sellos
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(100, Math.round((current / goal) * 100))}%`, backgroundColor: settings.brandColor }}
        />
      </div>
      <p
        role="status"
        className={cn(
          "mt-2 text-xs",
          tone === "ok" && "text-success-text",
          tone === "warn" && "text-warning-text",
          tone === "muted" && "text-text-2"
        )}
      >
        {text}
      </p>
    </section>
  );
}
