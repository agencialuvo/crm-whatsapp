"use client";

import type { Metrics } from "@/lib/saas";

const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(v >= 0.995 || v === 0 ? 0 : 1)} %`);

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const monthLabel = (key: string): string => {
  const [y, m] = key.split("-");
  return `${MONTHS[Number(m) - 1]} ${String(y).slice(2)}`;
};

/**
 * 045 — Conversión Demo → pago. La tasa «cerrada» (convirtieron / (convirtieron + perdidas)) es la que
 * importa: las pruebas todavía en curso no la deprimen. La «total» (sobre todas las que iniciaron) va debajo.
 */
export function ConversionCard({ metrics }: { metrics: Metrics }) {
  const c = metrics.conversion;
  return (
    <section className="rounded-lg border bg-card p-4" data-testid="conversion-card">
      <h3 className="mb-3 text-sm font-semibold">Conversión Demo → pago</h3>
      <p className="text-3xl font-bold tabular-nums" data-testid="conversion-rate">
        {pct(c.closedRate)}
      </p>
      <p className="text-xs text-text-3">de las pruebas ya cerradas (convirtieron + perdidas). Total sobre las que iniciaron: {pct(c.totalRate)}</p>
      {c.converted > 0 && (
        <p className="mt-1 text-xs text-text-3" data-testid="conv-by-source">
          Por cobro de Mercado Pago: {c.convertedBy.payment} · activadas a mano: {c.convertedBy.manual}
        </p>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm" data-testid="conversion-counts">
        <dt className="text-text-3">Iniciaron prueba</dt>
        <dd className="text-right tabular-nums" data-testid="conv-started">{c.started}</dd>
        <dt className="text-text-3">Convirtieron a pago</dt>
        <dd className="text-right tabular-nums" data-testid="conv-converted">{c.converted}</dd>
        <dt className="text-text-3">En curso</dt>
        <dd className="text-right tabular-nums" data-testid="conv-inprogress">{c.inProgress}</dd>
        <dt className="text-text-3">Vencidas o canceladas sin convertir</dt>
        <dd className="text-right tabular-nums" data-testid="conv-lost">{c.lost}</dd>
        <dt className="text-text-3">Mediana hasta convertir</dt>
        <dd className="text-right tabular-nums">{c.medianDaysToConvert === null ? "—" : `${c.medianDaysToConvert.toFixed(1)} días`}</dd>
      </dl>
      <div className="mt-4">
        <p className="kicker mb-1.5">Por mes de inicio</p>
        <ul className="space-y-1.5">
          {c.byMonth.map((m) => (
            <li key={m.month} className="flex items-center gap-2 text-xs">
              <span className="w-12 shrink-0 text-text-3">{monthLabel(m.month)}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-[4px] bg-subtle" aria-hidden>
                <div className="h-full rounded-[4px] bg-brand" style={{ width: `${(m.closedRate ?? 0) * 100}%` }} />
              </div>
              <span className="w-28 shrink-0 text-right tabular-nums">
                {m.converted}/{m.started} · {pct(m.closedRate)}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {c.excludedApproximate > 0 && (
        <p className="mt-3 text-xs text-text-3">
          {c.excludedApproximate} suscripción(es) anteriores al seguimiento no cuentan (no se vio cuándo empezó su prueba).
        </p>
      )}
    </section>
  );
}

/** Altas de los últimos 30 días (barras sin ejes: lo que importa es el ritmo). */
export function SignupsCard({ metrics }: { metrics: Metrics }) {
  const max = Math.max(1, ...metrics.signups.map((s) => s.count));
  const total = metrics.signups.reduce((n, s) => n + s.count, 0);
  return (
    <section className="rounded-lg border bg-card p-4" data-testid="signups-card">
      <h3 className="mb-1 text-sm font-semibold">Altas de los últimos 30 días</h3>
      <p className="mb-3 text-xs text-text-3">{total} organizaciones nuevas</p>
      <div className="flex h-16 items-end gap-[3px]" aria-hidden>
        {metrics.signups.map((s) => (
          <div
            key={s.day}
            title={`${s.day}: ${s.count}`}
            className="flex-1 rounded-t-[2px] bg-brand"
            style={{ height: `${Math.max(s.count === 0 ? 3 : 10, (s.count / max) * 100)}%`, opacity: s.count === 0 ? 0.25 : 0.85 }}
          />
        ))}
      </div>
    </section>
  );
}
