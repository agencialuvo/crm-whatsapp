"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CreditCard } from "lucide-react";
import { formatMoneyCents } from "@/lib/money";
import { PAYMENT_STATUS_LABEL, statusLabelOf, type EffectiveStatus } from "@/lib/saas";
import type { BillingStatusDto, CheckoutStatusDto } from "@/server/billing/dto";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTablePagination, DataTableToolbar } from "@/components/ui/data-table-pagination";
import { DialogCloseButton } from "@/components/ui/dialog-close";
import { useDataTable } from "@/components/ui/use-data-table";

const fecha = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—");

const TONE = { approved: "success", rejected: "destructive", pending: "secondary", refunded: "warning", charged_back: "destructive", cancelled: "secondary" } as const;

/**
 * 046 — La pantalla de suscripción del dueño: su plan y estado, los planes de pago con «Pagar con Mercado Pago»,
 * el cambio de plan, la cancelación y el historial de cobros. La misma pieza sirve en Ajustes → Suscripción y
 * en `/suscripcion-inactiva` (modo `blocked`). Los precios y estados los calcula el servidor; aquí solo se pintan.
 */
export function SubscriptionClient({ mode, isOwner, checkoutId }: { mode: "page" | "blocked"; isOwner: boolean; checkoutId?: string | null }) {
  const [status, setStatus] = useState<BillingStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [checkout, setCheckout] = useState<CheckoutStatusDto | null>(null);
  const polls = useRef(0);

  const load = useCallback(async () => {
    const r = await fetch("/api/billing/status", { cache: "no-store" });
    if (!r.ok) {
      setError("No se pudo cargar tu suscripción.");
      return;
    }
    setStatus((await r.json()) as BillingStatusDto);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Al volver de Mercado Pago: se confirma el pago (el servidor consulta a Mercado Pago al preguntar).
  useEffect(() => {
    if (!checkoutId) return;
    let vivo = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const r = await fetch(`/api/billing/checkout/${checkoutId}`, { cache: "no-store" });
      if (!vivo) return;
      if (r.ok) {
        const c = (await r.json()) as CheckoutStatusDto;
        setCheckout(c);
        if (c.status === "paid") {
          await load();
          // El acceso se libera: si estaba bloqueado, vuelve a la app.
          if (mode === "blocked") setTimeout(() => window.location.assign("/"), 1800);
          return;
        }
        if (c.status === "failed" || c.status === "abandoned") return;
      }
      if (++polls.current < 30) timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      vivo = false;
      if (timer) clearTimeout(timer);
    };
  }, [checkoutId, load, mode]);

  const post = async (url: string, body: unknown) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await r.json().catch(() => ({}))) as { error?: { message?: string }; url?: string; mode?: string };
    return { ok: r.ok, data };
  };

  const pay = async (planId: string) => {
    setBusy(planId);
    setError(null);
    const { ok, data } = await post("/api/billing/checkout", { planId });
    if (ok && data.url) {
      window.location.assign(data.url);
      return;
    }
    setError(data.error?.message ?? "No se pudo iniciar el pago.");
    setBusy(null);
  };

  const change = async (planId: string) => {
    setBusy(planId);
    setError(null);
    const { ok, data } = await post("/api/billing/change-plan", { planId });
    if (ok) setNotice(data.mode === "scheduled" ? "Listo: el cambio de plan rige desde tu próximo corte." : "Listo: cambiaste de plan. El precio nuevo rige desde tu próximo cobro.");
    else setError(data.error?.message ?? "No se pudo cambiar de plan.");
    setBusy(null);
    await load();
  };

  const cancel = async () => {
    setBusy("cancel");
    setError(null);
    const { ok, data } = await post("/api/billing/cancel", {});
    if (ok) setNotice("Cancelaste tu suscripción. Conservas el acceso hasta el fin del periodo pagado.");
    else setError(data.error?.message ?? "No se pudo cancelar.");
    setConfirmCancel(false);
    setBusy(null);
    await load();
  };

  const payments = status?.payments ?? [];
  const table = useDataTable(payments, { view: "billing-pagos", resetKey: "all" });
  const noun = useMemo(() => ({ one: "cobro", other: "cobros" }), []);

  if (!status) return <p className="text-sm text-text-3">{error ?? "Cargando…"}</p>;

  const managed = status.billingProvider === "mercadopago" && status.mpStatus === "authorized";
  const eff = status.status as EffectiveStatus | null;
  const label = eff ? statusLabelOf(eff, status.statusReason) : "Sin suscripción";
  const price = status.billedAmountCents ?? status.plans.find((p) => p.current)?.priceMonthlyCents ?? null;

  return (
    <div className="mx-auto max-w-3xl space-y-6" data-testid="subscription-page">
      {mode === "page" && <h3 className="text-lg font-bold">Suscripción</h3>}

      {checkoutId && checkout && (
        <div className="rounded-lg border bg-card p-4 text-sm" data-testid="checkout-banner" data-status={checkout.status}>
          {checkout.status === "paid" && <p className="font-medium text-success-text">Pago confirmado. Plan {checkout.planName} activo.</p>}
          {(checkout.status === "pending" || checkout.status === "authorized") && <p>Confirmando tu pago con Mercado Pago…</p>}
          {checkout.status === "failed" && <p className="text-destructive">{checkout.failureReason ?? "No se pudo completar el pago."} Puedes intentarlo de nuevo.</p>}
          {checkout.status === "abandoned" && <p className="text-text-3">El intento de pago venció. Puedes iniciarlo de nuevo.</p>}
        </div>
      )}
      {notice && (
        <p className="rounded-lg border bg-card p-3 text-sm" data-testid="billing-notice">
          {notice}
        </p>
      )}
      {error && (
        <p className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive" role="alert" data-testid="billing-error">
          {error}
        </p>
      )}

      <section className="rounded-lg border bg-card p-4" data-testid="subscription-status">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={eff === "active" ? "success" : eff === "trialing" ? "outline" : "warning"} data-testid="sub-status">
            {label}
          </Badge>
          <span className="text-sm font-medium" data-testid="sub-plan">{status.planName ?? "Sin plan"}</span>
          {price !== null && price > 0 && <span className="text-sm text-text-3">{formatMoneyCents(price, status.currency ?? "PEN", "es-PE")}/mes</span>}
        </div>
        <p className="mt-1 text-xs text-text-3">
          {eff === "trialing" && status.daysLeft !== null ? `${status.daysLeft} día(s) de prueba · ` : ""}
          {status.currentPeriodEnd ? `${status.cancelAtPeriodEnd ? "Acceso hasta" : eff === "active" ? "Próxima renovación" : "Corte"}: ${fecha(status.currentPeriodEnd)}` : "Sin fecha de corte"}
          {status.pendingPlanName ? ` · Cambiará a ${status.pendingPlanName} en el próximo corte` : ""}
        </p>
        {status.cancelAtPeriodEnd && <p className="mt-1 text-xs text-warning-text" data-testid="cancelling-note">Tu suscripción se cancela al corte; no se cobrará de nuevo.</p>}
        {status.graceEndsAt && (
          <p className="mt-1 text-xs text-warning-text" data-testid="grace-note">
            No pudimos cobrar tu plan. Actualiza tu medio de pago en Mercado Pago antes del {fecha(status.graceEndsAt)}.
          </p>
        )}
        {managed && !status.cancelAtPeriodEnd && eff === "active" && isOwner && (
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setConfirmCancel(true)} data-testid="cancel-subscription">
            Cancelar suscripción
          </Button>
        )}
      </section>

      {!isOwner && <p className="text-sm text-text-3">Solo el dueño de la cuenta puede contratar o cambiar el plan. Pídeselo a quien creó la cuenta.</p>}

      <section>
        <h4 className="kicker mb-2">Planes</h4>
        <div className="grid gap-3 sm:grid-cols-3">
          {status.plans.map((p) => (
            <div key={p.id} className="rounded-lg border bg-card p-4" data-testid={`plan-card-${p.name.toLowerCase()}`}>
              <p className="font-semibold">{p.name}</p>
              <p className="text-xl font-bold tabular-nums">{formatMoneyCents(p.priceMonthlyCents, p.currency, "es-PE")}<span className="text-xs font-normal text-text-3">/mes</span></p>
              <Button
                className="mt-3 w-full"
                size="sm"
                variant={p.current && managed ? "secondary" : "default"}
                disabled={!isOwner || busy !== null || (p.current && managed && !p.pending)}
                onClick={() => (managed ? change(p.id) : pay(p.id))}
                data-testid={`plan-action-${p.name.toLowerCase()}`}
              >
                <CreditCard className="mr-1.5 h-4 w-4" aria-hidden />
                {busy === p.id ? "Un momento…" : managed ? (p.current && !p.pending ? "Plan actual" : "Cambiar a este plan") : "Pagar con Mercado Pago"}
              </Button>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-text-3">El cobro es mensual y automático. El pago se hace en Mercado Pago: aquí no guardamos datos de tu tarjeta.</p>
      </section>

      <section>
        <h4 className="kicker mb-2">Historial de cobros</h4>
        {payments.length === 0 ? (
          <p className="text-sm text-text-3">Todavía no hay cobros.</p>
        ) : (
          <div data-testid="payments-table">
            <DataTableToolbar {...table.pagination} noun={noun} />
            <div className="overflow-x-auto rounded-lg border bg-card">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b bg-subtle text-left text-xs text-text-3">
                    <th className="px-3 py-2 font-medium">Fecha</th>
                    <th className="px-3 py-2 font-medium">Plan</th>
                    <th className="px-3 py-2 font-medium">Monto</th>
                    <th className="px-3 py-2 font-medium">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((p) => (
                    <tr key={p.id} className="border-b last:border-b-0" data-testid="payment-row">
                      <td className="px-3 py-2">{fecha(p.paidAt ?? p.debitDate ?? p.createdAt)}</td>
                      <td className="px-3 py-2">{p.planName ?? "—"}</td>
                      <td className="px-3 py-2 tabular-nums">{formatMoneyCents(p.amountCents, p.currency, "es-PE")}</td>
                      <td className="px-3 py-2">
                        <Badge variant={TONE[p.status as keyof typeof TONE] ?? "secondary"}>{PAYMENT_STATUS_LABEL[p.status] ?? p.status}</Badge>
                        {p.message && <div className="mt-0.5 text-xs text-text-3">{p.message}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DataTablePagination {...table.pagination} noun={noun} label="Paginación de cobros" />
          </div>
        )}
      </section>

      {confirmCancel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onClick={() => setConfirmCancel(false)} data-testid="cancel-dialog">
          <div className="relative w-full max-w-sm rounded-lg border bg-popover p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <DialogCloseButton onClick={() => setConfirmCancel(false)} />
            <h3 className="pr-8 text-base font-bold">¿Cancelar tu suscripción?</h3>
            <p className="mt-2 text-sm text-text-3">
              No se te cobrará de nuevo. Conservas el acceso hasta el {fecha(status.currentPeriodEnd)}.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(false)}>
                Volver
              </Button>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={cancel} data-testid="confirm-cancel">
                {busy === "cancel" ? "Cancelando…" : "Sí, cancelar"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
