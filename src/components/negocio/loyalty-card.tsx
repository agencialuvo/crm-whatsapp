"use client";

import { useCallback, useEffect, useState } from "react";
import { Cake, Check, Gift, SlidersHorizontal, Stamp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import {
  LOYALTY_TYPE_LABELS,
  MIN_ADJUST_NOTE,
  type LoyaltyCardViewDto,
  type LoyaltyTransactionDto,
} from "@/lib/loyalty";
import { cn } from "@/lib/utils";

/** Tope de casillas dibujadas: con un programa de 40 sellos la barra es más legible. */
const MAX_DOTS = 20;

const MOVEMENT_ICON = {
  earned: Stamp,
  redeemed: Gift,
  birthday_excluded: Cake,
  adjusted: Check,
} as const;

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/**
 * Fidelización — la tarjeta de sellos de un cliente y los botones para sellar o canjear
 * cuando está presente. Se oculta sola si el módulo está apagado (la API responde 404).
 */
export function LoyaltyCardPanel({ contactId, className }: { contactId: string; className?: string }) {
  const [view, setView] = useState<LoyaltyCardViewDto | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRedeem, setConfirmRedeem] = useState<number | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await apiFetch<LoyaltyCardViewDto>(`/api/loyalty/card?contactId=${encodeURIComponent(contactId)}`));
      setError(null);
    } catch (err) {
      if ((err as { status?: number }).status === 404) setHidden(true);
      else setError(describeError(err));
    }
  }, [contactId]);

  useEffect(() => {
    setView(null);
    setHidden(false);
    setConfirmRedeem(null);
    setAdjusting(false);
    setSuccess(null);
    void load();
  }, [load]);

  async function act(type: "earned" | "redeemed", milestoneStamps?: number) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await apiFetch("/api/loyalty/transaction", {
        method: "POST",
        json: {
          contactId,
          type,
          ...(milestoneStamps !== undefined ? { milestoneStamps } : {}),
          notes: type === "earned" ? "Sello manual en el local" : "Canje en el local",
        },
      });
      setConfirmRedeem(null);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;

  if (!view) {
    return (
      <div
        className={cn("h-28 animate-pulse rounded-md border bg-subtle", className)}
        aria-busy
        aria-label="Cargando tarjeta"
      />
    );
  }

  const { settings, rewardReady, availableMilestones, nextMilestone } = view;
  const required = Math.max(1, ...settings.milestones.map((m) => m.stamps));
  const stamps = view.card?.currentStamps ?? 0;
  const shown = Math.min(stamps, required);
  const dots = Math.min(required, MAX_DOTS);
  const filled = required > MAX_DOTS ? Math.round((shown / required) * MAX_DOTS) : shown;
  const pct = Math.min(100, Math.round((shown / required) * 100));
  // El color de marca es del negocio: lo llevan los sellos y la barra; el texto sigue el tema.
  const brand = /^#[0-9a-f]{6}$/i.test(settings.brandColor) ? settings.brandColor : "#111827";
  const redeemed = view.card?.totalRewardsRedeemed ?? 0;
  // Casilla (0-based) donde cae cada hito: ahí se dibuja el premio.
  const milestoneAt = new Map<number, string>();
  for (const m of settings.milestones) {
    const slot = required > MAX_DOTS ? Math.ceil((m.stamps / required) * MAX_DOTS) - 1 : m.stamps - 1;
    milestoneAt.set(slot, m.title);
  }
  const toRedeem = availableMilestones.find((m) => m.stamps === confirmRedeem) ?? null;

  return (
    <section className={cn("rounded-md border bg-subtle/50 p-3", className)} aria-label={settings.cardTitle}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="kicker">{settings.cardTitle}</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums">
            {shown} / {required} <span className="font-normal text-text-3">sellos</span>
          </p>
        </div>
        {rewardReady && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success-soft bg-success-tint px-2 py-0.5 text-[11px] font-semibold text-success-text">
            <Gift className="h-3 w-3" aria-hidden />
            ¡Premio disponible!
          </span>
        )}
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={required}
        aria-valuenow={shown}
        aria-label={`${shown} de ${required} sellos`}
        className="mt-2 flex flex-wrap gap-1"
      >
        {Array.from({ length: dots }, (_, i) => {
          const prize = milestoneAt.get(i);
          return (
            <span
              key={i}
              title={prize ? `Premio: ${prize}` : undefined}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full border transition-colors",
                i >= filled && "border-border-strong bg-background text-transparent",
                prize && i >= filled && "border-2 text-text-3"
              )}
              style={i < filled ? { backgroundColor: brand, borderColor: brand, color: "#fff" } : undefined}
            >
              {i < filled && settings.stampIconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={settings.stampIconUrl} alt="" className="h-3.5 w-3.5 rounded-full object-cover" />
              ) : prize && i >= filled ? (
                <Gift className="h-3 w-3" aria-hidden />
              ) : (
                <Check className="h-3 w-3" aria-hidden />
              )}
            </span>
          );
        })}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-border" aria-hidden>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: brand }} />
      </div>

      <p className="mt-2 text-xs text-text-3">
        {rewardReady && `Disponible: ${availableMilestones.map((m) => m.title).join(" · ")}`}
        {rewardReady && nextMilestone && " — "}
        {nextMilestone && `Faltan ${view.stampsRemaining} para: ${nextMilestone.title}`}
        {redeemed > 0 && ` · ${redeemed} canjeado${redeemed === 1 ? "" : "s"}`}
      </p>

      {error && (
        <p
          role="alert"
          className="mt-2 rounded-md border border-danger-soft bg-danger-tint px-2 py-1.5 text-xs text-danger-text"
        >
          {error}
        </p>
      )}
      {success && (
        <p
          role="status"
          className="mt-2 rounded-md border border-success-soft bg-success-tint px-2 py-1.5 text-xs text-success-text"
        >
          {success}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {toRedeem ? (
          <>
            <span className="text-xs text-text-2">
              ¿Canjear «{toRedeem.title}» y descontar {toRedeem.stamps} sellos?
            </span>
            <Button size="sm" disabled={busy} onClick={() => void act("redeemed", toRedeem.stamps)}>
              {busy ? "Canjeando…" : "Sí, canjear"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmRedeem(null)}>
              Cancelar
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act("earned")}>
              <Stamp className="mr-1 h-3.5 w-3.5" aria-hidden />
              {busy ? "Sellando…" : "Dar sello"}
            </Button>
            {availableMilestones.length === 0 ? (
              <Button size="sm" variant="outline" disabled>
                <Gift className="mr-1 h-3.5 w-3.5" aria-hidden />
                Canjear premio
              </Button>
            ) : (
              availableMilestones.map((m) => (
                <Button
                  key={m.stamps}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirmRedeem(m.stamps)}
                >
                  <Gift className="mr-1 h-3.5 w-3.5" aria-hidden />
                  {availableMilestones.length === 1 ? "Canjear premio" : `Canjear ${m.title}`}
                </Button>
              ))
            )}
            {view.canAdjust && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAdjusting(true)}>
                <SlidersHorizontal className="mr-1 h-3.5 w-3.5" aria-hidden />
                Ajustar sellos
              </Button>
            )}
          </>
        )}
      </div>

      {adjusting && (
        <AdjustDialog
          contactId={contactId}
          contactName={view.contact.name}
          current={stamps}
          onClose={() => setAdjusting(false)}
          onDone={async (text) => {
            setAdjusting(false);
            setSuccess(text);
            await load();
          }}
        />
      )}

      {view.recent.length > 0 && (
        <div className="mt-3 border-t pt-2">
          <p className="mb-1 text-[11px] font-medium text-text-3">Últimos movimientos</p>
          <ul className="space-y-1">
            {view.recent.slice(0, 5).map((m) => (
              <MovementRow key={m.id} m={m} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * Ajuste manual de sellos (migrar una tarjeta física o corregir un saldo): un número con
 * signo y el motivo, que queda en el historial para auditoría. La tarjeta nunca baja de 0.
 */
function AdjustDialog({
  contactId,
  contactName,
  current,
  onClose,
  onDone,
}: {
  contactId: string;
  contactName: string;
  current: number;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const delta = /^-?\d+$/.test(amount) ? Number(amount) : null;
  const after = delta === null ? null : current + delta;
  const amountError =
    amount !== "" && delta === null
      ? "Escribe un número entero"
      : delta === 0
        ? "El ajuste debe ser distinto de 0"
        : after !== null && after < 0
          ? `La tarjeta tiene ${current} sellos: no puedes quitar más de ${current}`
          : null;
  const noteOk = note.trim().length >= MIN_ADJUST_NOTE;
  const canSubmit = delta !== null && delta !== 0 && !amountError && noteOk && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || delta === null) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/loyalty/transaction", {
        method: "POST",
        json: { contactId, type: "adjusted", stampsChange: delta, notes: note.trim() },
      });
      await onDone(
        `Ajuste guardado: ${delta > 0 ? `+${delta}` : delta} sello${Math.abs(delta) === 1 ? "" : "s"} a ${contactName}. Ahora tiene ${current + delta}.`
      );
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Ajustar sellos"
      description={`${contactName} tiene ${current} sello${current === 1 ? "" : "s"}. Usa un número negativo para quitar.`}
      onClose={onClose}
      busy={busy}
      size="sm"
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="loy-adj-amount" required>Sellos a sumar o restar</Label>
          <Input
            id="loy-adj-amount"
            inputMode="numeric"
            value={amount}
            placeholder="Ej. 5 o -2"
            // Solo dígitos y un «-» al inicio.
            onChange={(e) => setAmount(e.target.value.replace(/[^\d-]/g, "").replace(/(?!^)-/g, "").slice(0, 4))}
            aria-invalid={!!amountError}
            disabled={busy}
            className="max-w-[10rem] tabular-nums"
          />
          {amountError ? (
            <p className="text-xs text-danger-text">{amountError}</p>
          ) : (
            after !== null && (
              <p className="text-xs text-text-3">
                Quedará con <span className="font-semibold text-text-2">{after}</span> sello{after === 1 ? "" : "s"}.
              </p>
            )
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="loy-adj-note" required>Motivo del ajuste</Label>
          <Input
            id="loy-adj-note"
            value={note}
            maxLength={200}
            placeholder="Ej. Migración de tarjeta física"
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
          />
          <p className="text-xs text-text-3">Queda en el historial de la tarjeta.</p>
        </div>
        <ModalFooter error={error}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {busy ? "Guardando…" : "Guardar ajuste"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function MovementRow({ m }: { m: LoyaltyTransactionDto }) {
  const Icon = MOVEMENT_ICON[m.type];
  return (
    <li className="flex items-center gap-2 text-xs">
      <Icon className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden />
      <span className="min-w-0 flex-1 truncate" title={m.notes ?? undefined}>
        {LOYALTY_TYPE_LABELS[m.type]}
      </span>
      <span
        className={cn(
          "shrink-0 font-medium tabular-nums",
          m.stampsChange > 0 && "text-success-text",
          m.stampsChange < 0 && "text-danger-text",
          m.stampsChange === 0 && "text-text-3"
        )}
      >
        {m.stampsChange > 0 ? `+${m.stampsChange}` : m.stampsChange}
      </span>
      <span className="shrink-0 tabular-nums text-text-3">{dayLabel(m.createdAt)}</span>
    </li>
  );
}
