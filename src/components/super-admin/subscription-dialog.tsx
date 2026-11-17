"use client";

import { useState } from "react";
import { ACTION_LABEL, TRIAL_EXTEND_MAX_DAYS, TRIAL_EXTEND_MIN_DAYS, type SubAction } from "@/lib/saas";
import type { OrganizationDetailDto, OrganizationRowDto, PlanDto } from "@/lib/super-admin";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { DialogCloseButton } from "@/components/ui/dialog-close";
import { Input } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { planOptions } from "./organizations-table";

const DESCRIPTION: Record<SubAction, string> = {
  assign: "La organización no tiene suscripción. Elige el plan que se le asigna.",
  activate: "Pasa la suscripción a un plan de pago activo por 30 días. Si venía de la prueba, cuenta como conversión (marcada como manual).",
  change_plan: "Cambia el plan sin tocar el estado de la suscripción.",
  extend_trial: `Suma días a la prueba (de ${TRIAL_EXTEND_MIN_DAYS} a ${TRIAL_EXTEND_MAX_DAYS}). Si ya venció, la reabre desde hoy.`,
  set_period_end: "Fija la fecha exacta en que termina el periodo actual.",
  suspend: "Suspende la suscripción. Con el bloqueo de suscripciones encendido, la organización deja de entrar a la app.",
  cancel: "Cancela la suscripción. Puedes dejarla activa hasta el final del periodo.",
  reactivate: "Vuelve a activar una suscripción suspendida o cancelada con un plan de pago, por 30 días.",
};

const DESTRUCTIVE: SubAction[] = ["suspend", "cancel"];

/**
 * 045 — Una acción manual sobre la suscripción. Toda acción pide un MOTIVO (queda en la historia y en la
 * auditoría) y se confirma en pantalla. Ventana con X y cierre al tocar fuera, como el resto del sistema.
 */
export function SubscriptionDialog({
  org,
  action,
  plans,
  onClose,
  onDone,
}: {
  org: OrganizationRowDto;
  action: SubAction;
  plans: PlanDto[];
  onClose: () => void;
  onDone: (detail: OrganizationDetailDto) => void;
}) {
  const needsPlan = action === "assign" || action === "activate" || action === "change_plan" || action === "reactivate";
  const onlyPaid = action === "activate" || action === "reactivate";
  const [planId, setPlanId] = useState(
    action === "change_plan" ? "" : onlyPaid && org.planId && plans.find((p) => p.id === org.planId && p.trialDays === null) ? org.planId : ""
  );
  const [days, setDays] = useState("7");
  const [periodEnd, setPeriodEnd] = useState("");
  const [atEnd, setAtEnd] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const daysNum = Number(days);
  const missing =
    reason.trim().length < 3 ||
    (needsPlan && !planId && !(onlyPaid && org.planId && !org.isTrialPlan)) ||
    (action === "extend_trial" && !(Number.isInteger(daysNum) && daysNum >= TRIAL_EXTEND_MIN_DAYS && daysNum <= TRIAL_EXTEND_MAX_DAYS)) ||
    (action === "set_period_end" && !periodEnd);

  async function submit() {
    if (saving || missing) return;
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = { action, reason: reason.trim() };
    if (needsPlan && planId) body.planId = planId;
    if (action === "extend_trial") body.days = daysNum;
    if (action === "set_period_end") body.periodEnd = periodEnd;
    if (action === "cancel" && atEnd) body.cancelAtPeriodEnd = true;
    const res = await fetch(`/api/super-admin/organizations/${org.id}/subscription`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as (OrganizationDetailDto & { error?: { message?: string } }) | null;
    setSaving(false);
    if (!res?.ok || !data) {
      setError(data?.error?.message ?? "No se pudo guardar el cambio");
      return;
    }
    onDone(data);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-overlay p-4" onClick={onClose} data-testid="subscription-dialog">
      <div className="relative w-full max-w-md rounded-lg border bg-popover p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <DialogCloseButton onClick={onClose} />
        <h3 className="pr-8 font-semibold">{ACTION_LABEL[action]}</h3>
        <p className="mt-0.5 text-sm text-text-3">{org.name}</p>
        <p className="mt-3 text-sm text-text-2">{DESCRIPTION[action]}</p>

        <div className="mt-4 space-y-3">
          {needsPlan && (
            <div>
              <label className="kicker mb-1 block">Plan</label>
              <SearchSelect
                value={planId}
                onChange={setPlanId}
                ariaLabel="Plan"
                placeholder={onlyPaid && org.planId && !org.isTrialPlan ? `Mantener ${org.planName}` : "Elige un plan…"}
                emptyLabel={onlyPaid && org.planId && !org.isTrialPlan ? `Mantener ${org.planName}` : undefined}
                emptyShowsPlaceholder
                searchPlaceholder="Buscar plan…"
                options={planOptions(plans, onlyPaid)}
              />
            </div>
          )}
          {action === "extend_trial" && (
            <div>
              <label className="kicker mb-1 block" htmlFor="sa-days">
                Días a sumar
              </label>
              <Input id="sa-days" type="number" min={TRIAL_EXTEND_MIN_DAYS} max={TRIAL_EXTEND_MAX_DAYS} value={days} onChange={(e) => setDays(e.target.value)} />
            </div>
          )}
          {action === "set_period_end" && (
            <div>
              <label className="kicker mb-1 block">Fecha de corte</label>
              <DatePicker value={periodEnd} onChange={setPeriodEnd} min={new Date().toISOString().slice(0, 10)} ariaLabel="Fecha de corte" />
            </div>
          )}
          {action === "cancel" && org.status === "active" && (
            <div className="flex items-center justify-between gap-3 rounded-md border bg-subtle px-3 py-2">
              <span className="text-sm">Mantener activa hasta el final del periodo</span>
              <Switch checked={atEnd} onCheckedChange={setAtEnd} label="Cancelar al final del periodo" size="sm" />
            </div>
          )}
          <div>
            <label className="kicker mb-1 block" htmlFor="sa-reason">
              Motivo (obligatorio)
            </label>
            <Textarea id="sa-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Por qué haces este cambio" rows={3} />
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive" data-testid="dialog-error">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end">
          <Button
            variant={DESTRUCTIVE.includes(action) ? "destructive" : "default"}
            disabled={saving || missing}
            onClick={() => void submit()}
            data-testid="dialog-confirm"
          >
            {saving ? "Guardando…" : `Confirmar: ${ACTION_LABEL[action].toLowerCase()}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
