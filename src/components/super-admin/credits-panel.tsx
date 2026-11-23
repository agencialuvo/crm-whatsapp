"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { formatCoins } from "@/lib/credits";
import type { CalibrationReport, OrgCalibrationRow, OrgCreditDetail } from "@/server/credits";
import type { ReconcileState } from "@/server/saas/credits-sync";
import { Button } from "@/components/ui/button";
import { DialogCloseButton } from "@/components/ui/dialog-close";
import { Input } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { Textarea } from "@/components/ui/textarea";

type Overview = { report: CalibrationReport; reconcile: ReconcileState | null };

const RANGES = [7, 30, 90] as const;
const nf = new Intl.NumberFormat("es-PE");
const when = (iso: string) => new Date(iso).toLocaleString("es-PE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const KIND_LABEL: Record<string, string> = {
  grant: "Cuota",
  expire: "Vencimiento",
  spend: "Consumo",
  topup: "Recarga",
  refund: "Reembolso",
  adjustment: "Ajuste",
  reversal: "Reverso",
};

/**
 * Monedas en el panel de Super Admin. Arriba, el reporte de CALIBRACIÓN (consumo por organización y servicio y lo
 * que el corte habría bloqueado en modo sombra); abajo, cada fila abre la pantalla de OPERADOR de esa organización:
 * saldo, últimos movimientos, ajuste manual (con motivo) y el interruptor del corte. Todo viene de
 * `/api/super-admin/credits/*`; esta pantalla no calcula nada de dinero.
 */
export function CreditsPanel() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyCut, setOnlyCut] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/super-admin/credits?days=${days}`).catch(() => null);
    if (!res?.ok) {
      setError("No se pudo cargar el reporte de monedas. Reintenta en un momento.");
      return;
    }
    setError(null);
    setData((await res.json()) as Overview);
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.report.rows ?? []).filter((r) => (!q || r.organizationName.toLowerCase().includes(q)) && (!onlyCut || r.wouldCutEvents > 0));
  }, [data, query, onlyCut]);

  async function reconcile(repair: boolean) {
    setReconciling(true);
    await fetch("/api/super-admin/credits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reconcile", repair }),
    }).catch(() => null);
    setReconciling(false);
    void load();
  }

  const t = data?.report.totals;
  const rec = data?.reconcile ?? null;

  return (
    <div className="space-y-6" data-testid="credits-panel" data-loaded={data ? "true" : "false"}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-bold tracking-tight">Monedas · calibración</h2>
          <p className="text-sm text-text-3">Consumo por organización y lo que el corte habría bloqueado. 1 moneda = 100 unidades.</p>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Rango">
          {RANGES.map((d) => (
            <Button key={d} size="sm" variant={days === d ? "default" : "outline"} onClick={() => setDays(d)} data-testid={`range-${d}`}>
              {d} días
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {data && !data.report.enabled && (
        <p className="rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-sm text-warning-text" data-testid="credits-off-banner">
          Las monedas están <b>apagadas</b> en esta instancia (<code>CREDITS</code>). Lo que ves es lo que quedó medido; los ajustes y el corte no se pueden aplicar hasta encenderlas.
        </p>
      )}

      {t && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="credits-totals">
          <Stat label="Organizaciones" value={nf.format(t.organizations)} hint={`${t.withAccount} con cuenta`} />
          <Stat label="Con corte activo" value={nf.format(t.cutEnabled)} hint="el resto, en modo sombra" />
          <Stat label="Consumo del rango" value={formatCoins(t.chargedUnits)} hint="monedas" />
          <Stat label="Habrían cortado" value={nf.format(t.orgsThatWouldBeCut)} hint="organizaciones" warn={t.orgsThatWouldBeCut > 0} />
          <Stat label="Eventos bloqueables" value={nf.format(t.wouldCutEvents)} hint="turnos y plantillas" warn={t.wouldCutEvents > 0} />
        </div>
      )}

      <div className="rounded-lg border bg-card p-4 text-sm" data-testid="reconcile-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span className="kicker">Conciliación (saldo vs. libro)</span>
            {rec ? (
              rec.error ? (
                <p className="text-destructive">Falló: {rec.error}</p>
              ) : rec.drifts.length === 0 ? (
                <p className="text-text-2">
                  {rec.checked} cuenta(s) cuadran · {when(rec.at)}
                </p>
              ) : (
                <p className="text-destructive" role="alert">
                  {rec.drifts.length} cuenta(s) NO cuadran · {when(rec.at)} ({rec.drifts.map((d) => d.organizationId).join(", ")})
                </p>
              )
            ) : (
              <p className="text-text-3">Aún no corrió desde que arrancó el servidor (corre sola una vez al día).</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={reconciling || !data?.report.enabled} onClick={() => void reconcile(false)} data-testid="reconcile-now">
              Conciliar ahora
            </Button>
            {rec && rec.drifts.length > 0 && (
              <Button size="sm" variant="destructive" disabled={reconciling} onClick={() => void reconcile(true)} data-testid="reconcile-repair">
                Reparar desde el libro
              </Button>
            )}
          </div>
        </div>
      </div>

      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-full border border-border-strong bg-chip px-3.5 py-[6px] shadow-sm focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand-soft sm:max-w-sm">
            <Search className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.7} />
            <input
              placeholder="Buscar organización…"
              aria-label="Buscar organización"
              onChange={(e) => setQuery(e.target.value)}
              className="w-full bg-transparent text-[13px] outline-none placeholder:text-text-3"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={onlyCut} onChange={(e) => setOnlyCut(e.target.checked)} data-testid="only-would-cut" />
            Solo los que habrían cortado
          </label>
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm" data-testid="credits-table">
            <thead className="bg-subtle text-left text-xs text-text-3">
              <tr>
                <th className="px-3 py-2">Organización</th>
                <th className="px-3 py-2 text-right">Saldo</th>
                <th className="px-3 py-2 text-right">Cuota</th>
                <th className="px-3 py-2">Corte</th>
                <th className="px-3 py-2 text-right">IA (turnos · monedas)</th>
                <th className="px-3 py-2 text-right">WhatsApp (envíos · monedas)</th>
                <th className="px-3 py-2 text-right">Habría cortado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={r.organizationId} r={r} onOpen={() => setOpenId(r.organizationId)} />
              ))}
              {data && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-text-3">
                    Sin organizaciones medidas en este rango.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {data?.report.truncated && <p className="mt-2 text-xs text-text-3">Hay más organizaciones que filas mostradas; afina la búsqueda.</p>}
      </section>

      {openId && <OperatorDialog organizationId={openId} onClose={() => setOpenId(null)} onChanged={() => void load()} />}
    </div>
  );
}

function Stat({ label, value, hint, warn }: { label: string; value: string; hint: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <span className="kicker">{label}</span>
      <p className={`mt-2 text-2xl font-bold tabular-nums ${warn ? "text-warning-text" : ""}`}>{value}</p>
      <p className="mt-0.5 text-xs text-text-3">{hint}</p>
    </div>
  );
}

function Row({ r, onOpen }: { r: OrgCalibrationRow; onOpen: () => void }) {
  const a = r.account;
  return (
    <tr className="cursor-pointer border-t hover:bg-subtle" onClick={onOpen} data-testid="credits-row" data-org={r.organizationId}>
      <td className="px-3 py-2 font-medium">{r.organizationName}</td>
      <td className="px-3 py-2 text-right tabular-nums">{a ? (a.unlimited ? "Sin tope" : formatCoins(a.total)) : "—"}</td>
      <td className="px-3 py-2 text-right tabular-nums text-text-2">{a && !a.unlimited ? `${formatCoins(a.planBalance)} / ${formatCoins(a.quota)}` : "—"}</td>
      <td className="px-3 py-2">{a ? (a.cutEnabled ? <span className="font-semibold text-destructive">Activo</span> : <span className="text-text-3">Sombra</span>) : <span className="text-text-3">Sin cuenta</span>}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {nf.format(r.ai.okEvents)} · {formatCoins(r.ai.chargedUnits)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {nf.format(r.whatsapp.okEvents)} · {formatCoins(r.whatsapp.chargedUnits)}
      </td>
      <td className={`px-3 py-2 text-right tabular-nums ${r.wouldCutEvents > 0 ? "font-semibold text-warning-text" : "text-text-3"}`}>{nf.format(r.wouldCutEvents)}</td>
    </tr>
  );
}

/** La pantalla de operador de UNA organización: saldo, movimientos, ajuste manual y corte. */
function OperatorDialog({ organizationId, onClose, onChanged }: { organizationId: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<OrgCreditDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<"plan" | "topup">("topup");
  const [coins, setCoins] = useState("");
  const [note, setNote] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [confirmCut, setConfirmCut] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/super-admin/credits/${organizationId}`).catch(() => null);
    if (!res?.ok) {
      setError("No se pudo cargar la organización.");
      return;
    }
    setDetail((await res.json()) as OrgCreditDetail);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>): Promise<boolean> {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/super-admin/credits/${organizationId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { detail?: OrgCreditDetail; error?: { message?: string } } | null;
    setSaving(false);
    if (!res?.ok || !data) {
      setError(data?.error?.message ?? "No se pudo aplicar el cambio");
      return false;
    }
    if (data.detail) setDetail(data.detail);
    onChanged();
    return true;
  }

  const amount = Number(coins.replace(",", "."));
  const invalid = !Number.isFinite(amount) || amount === 0 || note.trim().length < 3;
  const a = detail?.account ?? null;

  async function adjust() {
    if (saving || invalid) return;
    const ok = await post({ action: "adjust", bucket, coins: amount, note: note.trim(), requestId });
    if (ok) {
      setCoins("");
      setNote("");
      setRequestId(crypto.randomUUID()); // un ajuste nuevo es otra operación
    }
  }

  async function toggleCut() {
    if (!a) return;
    if (!a.cutEnabled && !confirmCut) return setConfirmCut(true);
    setConfirmCut(false);
    await post({ action: "cut", cutEnabled: !a.cutEnabled });
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-overlay" onClick={onClose} data-testid="credits-operator">
      <aside className="relative h-full w-full max-w-lg overflow-y-auto border-l bg-popover p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <DialogCloseButton onClick={onClose} />
        <h3 className="pr-8 text-lg font-bold">{detail?.organizationName ?? "Cargando…"}</h3>
        {detail && !detail.enabled && <p className="mt-1 text-sm text-warning-text">Monedas apagadas: solo lectura.</p>}

        {detail && (
          <>
            <section className="mt-4 rounded-lg border p-3" data-testid="operator-balance">
              {a ? (
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <span className="kicker">Cuota del plan</span>
                    <p className="font-bold tabular-nums">{a.unlimited ? "Sin tope" : `${formatCoins(a.planBalance)} / ${formatCoins(a.quota)}`}</p>
                  </div>
                  <div>
                    <span className="kicker">Recargas</span>
                    <p className={`font-bold tabular-nums ${a.topupBalance < 0 ? "text-destructive" : ""}`}>{formatCoins(a.topupBalance)}</p>
                  </div>
                  <div>
                    <span className="kicker">Total</span>
                    <p className="font-bold tabular-nums">{a.unlimited ? "—" : formatCoins(a.total)}</p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-text-3">Esta organización aún no tiene cuenta de monedas (se crea con su primera cuota o con un ajuste).</p>
              )}
            </section>

            <section className="mt-4 flex items-center justify-between gap-3 rounded-lg border p-3" data-testid="operator-cut">
              <div className="text-sm">
                <p className="font-semibold">Corte por falta de saldo: {a?.cutEnabled ? <span className="text-destructive">ACTIVO</span> : "modo sombra"}</p>
                <p className="text-text-3">
                  {a?.cutEnabled
                    ? "Sin saldo, el agente se calla y las plantillas no salen."
                    : "Se mide y se avisa, pero nunca se corta."}
                </p>
                {confirmCut && <p className="mt-1 font-medium text-destructive">¿Seguro? Este cliente dejará de recibir respuestas del agente si se queda sin saldo.</p>}
              </div>
              <Button
                size="sm"
                variant={a?.cutEnabled ? "outline" : "destructive"}
                disabled={saving || !detail.enabled}
                onClick={() => void toggleCut()}
                data-testid="toggle-cut"
              >
                {a?.cutEnabled ? "Volver a sombra" : confirmCut ? "Sí, activar corte" : "Activar corte"}
              </Button>
            </section>

            <section className="mt-4 space-y-3 rounded-lg border p-3" data-testid="operator-adjust">
              <p className="font-semibold">Ajuste manual</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="kicker mb-1 block" htmlFor="adj-bucket">
                    Saldo
                  </label>
                  <SearchSelect
                    value={bucket}
                    onChange={(v) => setBucket(v === "plan" ? "plan" : "topup")}
                    ariaLabel="Saldo a ajustar"
                    placeholder="Elige el saldo…"
                    searchPlaceholder="Buscar…"
                    options={[
                      { value: "topup", label: "Recargas (no vence)" },
                      { value: "plan", label: "Cuota del plan (este mes)" },
                    ]}
                  />
                </div>
                <div>
                  <label className="kicker mb-1 block" htmlFor="adj-coins">
                    Monedas (+ suma, − resta)
                  </label>
                  <Input id="adj-coins" inputMode="decimal" value={coins} onChange={(e) => setCoins(e.target.value)} placeholder="Ej. 100 o -20" />
                </div>
              </div>
              <div>
                <label className="kicker mb-1 block" htmlFor="adj-note">
                  Motivo (obligatorio)
                </label>
                <Textarea id="adj-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} placeholder="Queda en el libro con tu usuario" />
              </div>
              <Button disabled={saving || invalid || !detail.enabled} onClick={() => void adjust()} data-testid="apply-adjust">
                Aplicar ajuste
              </Button>
            </section>

            {error && (
              <p role="alert" className="mt-3 text-sm text-destructive" data-testid="operator-error">
                {error}
              </p>
            )}

            <section className="mt-5">
              <p className="kicker mb-1">Habría cortado ({detail.wouldCutTotal} en 30 días)</p>
              {detail.wouldCut.length === 0 ? (
                <p className="text-sm text-text-3">Nada que el corte hubiera bloqueado.</p>
              ) : (
                <ul className="max-h-40 overflow-y-auto text-xs text-text-2" data-testid="operator-wouldcut">
                  {detail.wouldCut.map((w) => (
                    <li key={w.id} className="flex justify-between border-b py-1">
                      <span>
                        {when(w.createdAt)} · {w.service === "whatsapp" ? `WhatsApp ${w.category ?? ""}` : "IA"}
                      </span>
                      <span className="tabular-nums">{formatCoins(w.chargedUnits)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="mt-5">
              <p className="kicker mb-1">Últimos movimientos</p>
              <ul className="text-xs" data-testid="operator-ledger">
                {detail.ledger.map((l) => (
                  <li key={l.id} className="flex items-start justify-between gap-2 border-b py-1">
                    <span>
                      {when(l.createdAt)} · {KIND_LABEL[l.kind] ?? l.kind} · {l.bucket === "plan" ? "plan" : "recarga"}
                      {l.note ? ` · ${l.note}` : ""}
                    </span>
                    <span className={`tabular-nums ${l.amount < 0 ? "text-destructive" : "text-success-text"}`}>{formatCoins(l.amount)}</span>
                  </li>
                ))}
                {detail.ledger.length === 0 && <li className="py-2 text-text-3">Sin movimientos.</li>}
              </ul>
            </section>
          </>
        )}
        {!detail && error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </aside>
    </div>
  );
}
