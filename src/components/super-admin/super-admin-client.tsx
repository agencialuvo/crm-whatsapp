"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { matchesStatusFilter, STATUS_LABEL, type EffectiveStatus, type Metrics, type StatusFilter, type SubAction } from "@/lib/saas";
import type { OrganizationDetailDto, OrganizationRowDto, PlanDto } from "@/lib/super-admin";
import { normalizeText } from "@/lib/search";
import { SearchSelect } from "@/components/ui/search-select";
import { ConversionCard, SignupsCard } from "./conversion-card";
import { MetricCards } from "./metric-cards";
import { OrganizationDrawer } from "./organization-drawer";
import { OrganizationsTable } from "./organizations-table";
import { PlanBreakdown } from "./plan-breakdown";
import { SubscriptionDialog } from "./subscription-dialog";

const STATUS_OPTIONS: { value: EffectiveStatus | "none"; label: string }[] = [
  { value: "trialing", label: STATUS_LABEL.trialing },
  { value: "trial_expired", label: STATUS_LABEL.trial_expired },
  { value: "active", label: STATUS_LABEL.active },
  { value: "past_due", label: STATUS_LABEL.past_due },
  { value: "paused", label: STATUS_LABEL.paused },
  { value: "canceled", label: STATUS_LABEL.canceled },
  { value: "none", label: "Sin suscripción" },
];

/**
 * 045 — El panel de Super Admin: dashboard arriba, directorio abajo. Todo viene de `/api/super-admin/*`; el
 * directorio se carga una vez (hasta 5 000 filas) y se filtra y pagina aquí. Tras cada acción se vuelve a pedir
 * el dashboard y el directorio: lo que se ve es lo que hay en la base.
 */
export function SuperAdminClient() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [orgs, setOrgs] = useState<OrganizationRowDto[]>([]);
  const [plans, setPlans] = useState<PlanDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [planFilter, setPlanFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [openId, setOpenId] = useState<string | null>(null);
  const [drawerKey, setDrawerKey] = useState(0);
  const [pending, setPending] = useState<{ orgId: string; action: SubAction } | null>(null);

  const load = useCallback(async () => {
    const [m, o, p] = await Promise.all([
      fetch("/api/super-admin/metrics").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/super-admin/organizations").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/super-admin/plans").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (!m || !o || !p) {
      setError("No se pudo cargar el panel. Reintenta en un momento.");
    } else {
      setError(null);
      setMetrics(m as Metrics);
      setOrgs((o as { organizations: OrganizationRowDto[] }).organizations);
      setPlans((p as { plans: PlanDto[] }).plans);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const q = normalizeText(query.trim());
    return orgs.filter((o) => {
      if (q && !normalizeText(`${o.name} ${o.ownerName ?? ""} ${o.ownerEmail ?? ""}`).includes(q)) return false;
      if (planFilter && o.planId !== planFilter) return false;
      if (statusFilter && !matchesStatusFilter(o.status, o.statusReason, statusFilter as StatusFilter)) return false;
      return true;
    });
  }, [orgs, query, planFilter, statusFilter]);

  const open = orgs.find((o) => o.id === openId) ?? null;
  const target = pending ? (orgs.find((o) => o.id === pending.orgId) ?? null) : null;

  function onDone(detail: OrganizationDetailDto) {
    // La fila cambia al instante con lo que devolvió el servidor; el dashboard y el directorio se vuelven a pedir.
    setOrgs((prev) => prev.map((o) => (o.id === detail.organization.id ? detail.organization : o)));
    setPending(null);
    setDrawerKey((k) => k + 1);
    void load();
  }

  return (
    <div className="space-y-6" data-testid="super-admin-panel" data-loaded={loaded ? "true" : "false"}>
      {error && (
        <p role="alert" className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {metrics && (
        <>
          <MetricCards metrics={metrics} />
          <div className="grid gap-4 lg:grid-cols-3">
            <ConversionCard metrics={metrics} />
            <PlanBreakdown metrics={metrics} />
            <SignupsCard metrics={metrics} />
          </div>
        </>
      )}

      <section>
        <h2 className="mb-3 text-base font-bold tracking-tight">Organizaciones</h2>
        <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="directory-filters">
          <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-full border border-border-strong bg-chip px-3.5 py-[6px] shadow-sm focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand-soft sm:max-w-sm">
            <Search className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.7} />
            <input
              placeholder="Buscar organización, dueño o correo…"
              aria-label="Buscar organización"
              defaultValue=""
              onChange={(e) => setQuery(e.target.value)}
              className="w-full bg-transparent text-[13px] outline-none placeholder:text-text-3"
            />
          </div>
          <SearchSelect
            value={planFilter}
            onChange={setPlanFilter}
            ariaLabel="Filtrar por plan"
            placeholder="Todo plan"
            emptyLabel="Todo plan"
            emptyShowsPlaceholder
            searchPlaceholder="Buscar plan…"
            options={plans.map((p) => ({ value: p.id, label: p.name }))}
            className="w-44"
          />
          <SearchSelect
            value={statusFilter}
            onChange={setStatusFilter}
            ariaLabel="Filtrar por estado"
            placeholder="Todo estado"
            emptyLabel="Todo estado"
            emptyShowsPlaceholder
            searchPlaceholder="Buscar estado…"
            options={STATUS_OPTIONS}
            className="w-48"
          />
        </div>
        <OrganizationsTable
          rows={rows}
          resetKey={`${query}|${planFilter}|${statusFilter}`}
          onOpen={(o) => setOpenId(o.id)}
          onAction={(o, action) => setPending({ orgId: o.id, action })}
        />
      </section>

      {open && (
        <OrganizationDrawer
          org={open}
          refreshKey={drawerKey}
          onClose={() => setOpenId(null)}
          onAction={(action) => setPending({ orgId: open.id, action })}
        />
      )}

      {pending && target && (
        <SubscriptionDialog org={target} action={pending.action} plans={plans} onClose={() => setPending(null)} onDone={onDone} />
      )}
    </div>
  );
}
