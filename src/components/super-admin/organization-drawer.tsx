"use client";

import { useEffect, useState } from "react";
import { formatMoneyCents } from "@/lib/money";
import { ACTION_LABEL, availableActions, PAYMENT_STATUS_LABEL, STATUS_LABEL, type EffectiveStatus, type SubAction, type SubEventType } from "@/lib/saas";
import type { OrganizationDetailDto, OrganizationRowDto } from "@/lib/super-admin";
import { Button } from "@/components/ui/button";
import { DialogCloseButton } from "@/components/ui/dialog-close";
import { StatusBadge } from "./organizations-table";

const EVENT_LABEL: Record<SubEventType, string> = {
  trial_started: "Empezó la prueba",
  converted: "Convirtió a plan de pago",
  reactivated: "Reactivada",
  plan_changed: "Cambio de plan",
  status_changed: "Cambio de estado",
  trial_extended: "Prueba extendida",
  period_changed: "Corte modificado",
  expired: "La prueba venció",
  assigned: "Plan asignado",
  renewed: "Cobro mensual aprobado",
  payment_failed: "Cobro rechazado",
  refunded: "Reembolso o contracargo",
};

const SOURCE_LABEL = { signup: "alta", admin: "panel", system: "sistema", payment: "cobro" } as const;

/** `trialing` → «En prueba»: la historia se lee en español, no con los nombres internos. */
const estado = (s: string | null): string => (s ? (STATUS_LABEL[s as EffectiveStatus] ?? s) : "");

const cuando = (iso: string): string =>
  new Date(iso).toLocaleString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * 045 — El cajón de una organización: su suscripción, todas las acciones disponibles y la HISTORIA (eventos de
 * suscripción + auditoría de lo que hizo el Super Admin). La historia es lo que vuelve medible la conversión.
 */
export function OrganizationDrawer({
  org,
  refreshKey,
  onClose,
  onAction,
}: {
  org: OrganizationRowDto;
  /** Cambia cuando una acción terminó: vuelve a pedir la historia. */
  refreshKey: number;
  onClose: () => void;
  onAction: (action: SubAction) => void;
}) {
  const [detail, setDetail] = useState<OrganizationDetailDto | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let vivo = true;
    setError(false);
    void fetch(`/api/super-admin/organizations/${org.id}`)
      .then((r) => (r.ok ? (r.json() as Promise<OrganizationDetailDto>) : null))
      .then((d) => {
        if (!vivo) return;
        if (d) setDetail(d);
        else setError(true);
      })
      .catch(() => vivo && setError(true));
    return () => {
      vivo = false;
    };
  }, [org.id, refreshKey]);

  const current = detail?.organization ?? org;
  const acciones = availableActions(current.status, current.isTrialPlan, current.statusReason, current.managedByProvider ? current.billingProvider : null);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-overlay" onClick={onClose} data-testid="organization-drawer">
      <aside className="relative h-full w-full max-w-md overflow-y-auto border-l bg-popover p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <DialogCloseButton onClick={onClose} />
        <h3 className="pr-8 text-lg font-bold">{current.name}</h3>
        <p className="text-sm text-text-3">
          {current.ownerName ?? "Sin dueño"}
          {current.ownerEmail ? ` · ${current.ownerEmail}` : ""}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusBadge status={current.status} reason={current.statusReason} />
          <span className="text-sm">{current.planName ?? "Sin plan"}</span>
          {current.planActive === false && <span className="text-xs text-text-3">(plan anterior)</span>}
        </div>
        <p className="mt-1 text-xs text-text-3">
          {current.currentPeriodEnd ? `Corte: ${cuando(current.currentPeriodEnd)}` : "Sin fecha de corte"}
          {current.status === "trialing" && current.daysLeft !== null ? ` · ${current.daysLeft} día(s) de prueba` : ""}
        </p>
        <p className="mt-1 text-xs text-text-3" data-testid="drawer-billing">
          {current.billingProvider === "mercadopago"
            ? `Cobro: Mercado Pago${current.mpStatus ? ` (${current.mpStatus})` : ""}${current.lastPaymentAt ? ` · último pago ${cuando(current.lastPaymentAt)}` : ""}${current.nextPaymentAt ? ` · próximo ${cuando(current.nextPaymentAt)}` : ""}${current.pendingPlanName ? ` · cambia a ${current.pendingPlanName} al corte` : ""}`
            : "Cobro: manual"}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {acciones.map((a) => (
            <Button key={a} size="sm" variant={a === "suspend" || a === "cancel" ? "outline" : "secondary"} onClick={() => onAction(a)} data-testid={`drawer-action-${a}`}>
              {ACTION_LABEL[a]}
            </Button>
          ))}
        </div>

        <h4 className="kicker mb-2 mt-6">Historia de la suscripción</h4>
        {error && <p className="text-sm text-destructive">No se pudo cargar la historia.</p>}
        {!detail && !error && <p className="text-sm text-text-3">Cargando…</p>}
        {detail && detail.events.length === 0 && <p className="text-sm text-text-3">Sin movimientos registrados.</p>}
        <ul className="space-y-2" data-testid="event-list">
          {detail?.events.map((e) => (
            <li key={e.id} className="rounded-md border bg-card px-3 py-2 text-sm" data-testid="event-item">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{EVENT_LABEL[e.type]}</span>
                <span className="shrink-0 text-xs text-text-3">{cuando(e.occurredAt)}</span>
              </div>
              <p className="text-xs text-text-3">
                {e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus ? `${estado(e.fromStatus)} → ${estado(e.toStatus)}` : estado(e.toStatus)}
                {e.fromPlanName && e.toPlanName && e.fromPlanName !== e.toPlanName ? ` · ${e.fromPlanName} → ${e.toPlanName}` : e.toPlanName ? ` · ${e.toPlanName}` : ""}
                {" · "}
                {SOURCE_LABEL[e.source]}
                {e.actorName ? ` · ${e.actorName}` : ""}
                {e.approximate ? " · aproximada" : ""}
              </p>
              {e.reason && <p className="mt-0.5 text-xs">«{e.reason}»</p>}
            </li>
          ))}
        </ul>

        {detail && detail.payments.length > 0 && (
          <>
            <h4 className="kicker mb-2 mt-6">Cobros</h4>
            <ul className="space-y-2" data-testid="payment-list">
              {detail.payments.map((p) => (
                <li key={p.id} className="rounded-md border bg-card px-3 py-2 text-xs" data-testid="payment-item">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {PAYMENT_STATUS_LABEL[p.status] ?? p.status} · {formatMoneyCents(p.amountCents, p.currency, "es-PE")}
                    </span>
                    <span className="shrink-0 text-text-3">{cuando(p.paidAt ?? p.debitDate ?? p.createdAt)}</span>
                  </div>
                  <p className="text-text-3">
                    {p.planName ?? ""}
                    {p.message ? ` · ${p.message}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}

        {detail && detail.audit.length > 0 && (
          <>
            <h4 className="kicker mb-2 mt-6">Auditoría</h4>
            <ul className="space-y-2" data-testid="audit-list">
              {detail.audit.map((a) => (
                <li key={a.id} className="rounded-md border bg-card px-3 py-2 text-xs" data-testid="audit-item">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{ACTION_LABEL[a.action as SubAction] ?? a.action}</span>
                    <span className="shrink-0 text-text-3">{cuando(a.createdAt)}</span>
                  </div>
                  <p className="text-text-3">{a.actorEmail ?? "operador del servidor"}</p>
                  {a.reason && <p className="mt-0.5">«{a.reason}»</p>}
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}
