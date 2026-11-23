import { formatCoins, formatCoinsLabel } from "@/lib/credits";
import type { CreditSummary } from "@/server/saas/credits-summary";

/** El 100 % de la barra de cuota (no es un campo de porcentaje editable). */
const BARRA_LLENA = 100;

type Summary = Extract<CreditSummary, { enabled: true }>;

const fecha = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }) : null;

/**
 * «Mis monedas»: el saldo disponible, cuánto queda de la cuota del periodo frente a las recargas, y en qué se gastó
 * (agente de IA vs. WhatsApp). Es solo lectura y no calcula nada de dinero: pinta lo que dice el servidor. En modo
 * sombra (corte apagado) lo dice claro: se mide y se muestra, pero nada se detiene.
 */
export function CreditsCard({ summary }: { summary: Summary }) {
  if (!summary.metered) {
    return (
      <section className="rounded-lg border bg-card p-5" data-testid="credits-card" data-state="unmetered">
        <h3 className="font-semibold">Mis monedas</h3>
        <p className="mt-2 text-sm text-text-2">
          Tu plan todavía no tiene monedas asignadas. Cuando tu suscripción esté activa, aquí verás tu saldo y tu consumo.
        </p>
      </section>
    );
  }

  const usedFromQuota = Math.max(summary.quota - Math.max(summary.planBalance, 0), 0);
  const pct = summary.quota > 0 ? Math.min(100, Math.round((usedFromQuota / summary.quota) * 100)) : 0;
  const totalSpend = summary.spend.ai.units + summary.spend.whatsapp.units;
  const share = (units: number) => (totalSpend > 0 ? Math.round((units / totalSpend) * 100) : 0);
  const hasta = fecha(summary.periodEnd);
  const sinSaldo = !summary.unlimited && summary.total <= 0;

  return (
    <section className="space-y-5 rounded-lg border bg-card p-5" data-testid="credits-card" data-state={summary.cutEnabled ? "cut" : "shadow"}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-semibold">Mis monedas</h3>
          <p className="text-sm text-text-3">El agente de IA y las plantillas de WhatsApp consumen monedas.</p>
        </div>
        <div className="text-right">
          <span className="kicker">Disponible</span>
          <p className={`text-3xl font-bold tabular-nums ${sinSaldo ? "text-destructive" : ""}`} data-testid="credits-total">
            {summary.unlimited ? "Sin tope" : formatCoins(summary.total)}
          </p>
        </div>
      </div>

      {!summary.cutEnabled && (
        <p className="rounded-md border bg-subtle px-3 py-2 text-sm text-text-2" data-testid="credits-shadow-note">
          Por ahora las monedas se <b>miden pero no detienen nada</b>: tu agente y tus plantillas siguen funcionando aunque el saldo llegue a cero.
        </p>
      )}
      {summary.cutEnabled && sinSaldo && (
        <p role="alert" className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-destructive" data-testid="credits-empty-note">
          Sin monedas: tu agente está en pausa y las plantillas no salen. Los mensajes de tus clientes siguen llegando a la bandeja para que los atiendas tú.
        </p>
      )}

      {!summary.unlimited && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-md border p-3" data-testid="credits-plan">
            <span className="kicker">Cuota de tu plan{hasta ? ` · renueva ${hasta}` : ""}</span>
            <p className="mt-1 text-xl font-bold tabular-nums">
              {formatCoins(Math.max(summary.planBalance, 0))} <span className="text-sm font-normal text-text-3">de {formatCoins(summary.quota)}</span>
            </p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={BARRA_LLENA} aria-label="Cuota usada">
              <div className={`h-full ${pct >= 80 ? "bg-warning-text" : "bg-brand"}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1 text-xs text-text-3">{pct}% usado · lo que sobre no se acumula al próximo periodo</p>
          </div>
          <div className="rounded-md border p-3" data-testid="credits-topup">
            <span className="kicker">Recargas</span>
            <p className={`mt-1 text-xl font-bold tabular-nums ${summary.topupBalance < 0 ? "text-destructive" : ""}`}>{formatCoins(summary.topupBalance)}</p>
            <p className="mt-1 text-xs text-text-3">
              {summary.topupBalance < 0 ? "Saldo en deuda: se compensa con tu próxima recarga." : "No vencen. Se usan cuando se acaba la cuota del plan."}
            </p>
          </div>
        </div>
      )}
      {summary.unlimited && <p className="text-sm text-text-2">Tu plan no tiene tope de monedas: se mide tu consumo, pero nunca se detiene.</p>}

      <div data-testid="credits-usage">
        <span className="kicker">Consumo de este periodo</span>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <Usage label="Agente de IA" detail={`${summary.spend.ai.count} ${summary.spend.ai.count === 1 ? "respuesta" : "respuestas"}`} units={summary.spend.ai.units} pct={share(summary.spend.ai.units)} testId="usage-ai" />
          <Usage label="Plantillas de WhatsApp" detail={`${summary.spend.whatsapp.count} ${summary.spend.whatsapp.count === 1 ? "plantilla" : "plantillas"}`} units={summary.spend.whatsapp.units} pct={share(summary.spend.whatsapp.units)} testId="usage-wa" />
        </div>
        <p className="mt-2 text-xs text-text-3">
          Cada respuesta del agente cuesta {summary.turnCost > 0 ? formatCoinsLabel(summary.turnCost) : "0 monedas"}; los mensajes de texto dentro de las 24 h no cuestan.
        </p>
      </div>
    </section>
  );
}

function Usage({ label, detail, units, pct, testId }: { label: string; detail: string; units: number; pct: number; testId: string }) {
  return (
    <div className="rounded-md border p-3" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-sm font-bold tabular-nums">{formatCoins(units)}</span>
      </div>
      <p className="text-xs text-text-3">
        {detail} · {pct}% del consumo
      </p>
    </div>
  );
}
