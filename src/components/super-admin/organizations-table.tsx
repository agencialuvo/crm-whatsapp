"use client";

import { useMemo } from "react";
import { Building2 } from "lucide-react";
import { ACTION_LABEL, availableActions, statusLabelOf, STATUS_TONE, type EffectiveStatus, type SubAction } from "@/lib/saas";
import { formatMoneyCents } from "@/lib/money";
import type { OrganizationRowDto, PlanDto } from "@/lib/super-admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTablePagination, DataTableToolbar } from "@/components/ui/data-table-pagination";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchSelect } from "@/components/ui/search-select";
import { useDataTable } from "@/components/ui/use-data-table";

const TONE_TO_VARIANT = { success: "success", warning: "warning", danger: "destructive", neutral: "secondary", info: "outline" } as const;

export function StatusBadge({ status, reason }: { status: EffectiveStatus | null; reason: string | null }) {
  if (status === null) return <Badge variant="secondary">Sin suscripción</Badge>;
  return <Badge variant={TONE_TO_VARIANT[STATUS_TONE[status]]}>{statusLabelOf(status, reason)}</Badge>;
}

const fecha = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—");

/**
 * 045 — El directorio de organizaciones. Pagina en el cliente con el patrón del sistema (`useDataTable` +
 * `DataTableToolbar` + `DataTablePagination`) sobre la lista ya filtrada por la pantalla.
 */
export function OrganizationsTable({
  rows,
  resetKey,
  onOpen,
  onAction,
}: {
  rows: OrganizationRowDto[];
  /** Cambia con los filtros: la tabla vuelve a la primera página. */
  resetKey: string;
  onOpen: (row: OrganizationRowDto) => void;
  onAction: (row: OrganizationRowDto, action: SubAction) => void;
}) {
  const table = useDataTable(rows, { view: "super-admin-organizaciones", resetKey });
  const noun = useMemo(() => ({ one: "organización", other: "organizaciones" }), []);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="Sin organizaciones"
        description="Ninguna organización coincide con los filtros."
        className="rounded-lg border border-dashed"
      />
    );
  }

  return (
    <div data-testid="organizations-table">
      <DataTableToolbar {...table.pagination} noun={noun} />
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b bg-subtle text-left text-xs text-text-3">
              <th className="px-3 py-2 font-medium">Organización</th>
              <th className="px-3 py-2 font-medium">Dueño</th>
              <th className="px-3 py-2 font-medium">Plan</th>
              <th className="px-3 py-2 font-medium">Estado</th>
              <th className="px-3 py-2 font-medium">Prueba / corte</th>
              <th className="px-3 py-2 font-medium">Alta</th>
              <th className="w-44 px-3 py-2 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((o) => {
              const acciones = availableActions(o.status, o.isTrialPlan, o.statusReason, o.managedByProvider ? o.billingProvider : null);
              return (
                <tr key={o.id} data-testid="org-row" data-org-id={o.id} className="border-b last:border-b-0">
                  <td className="px-3 py-2.5">
                    <button type="button" onClick={() => onOpen(o)} className="text-left font-medium hover:underline" data-testid="org-name">
                      {o.name}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <div data-testid="org-owner">{o.ownerName ?? "—"}</div>
                    <div className="text-xs text-text-3" data-testid="org-email">{o.ownerEmail ?? ""}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span data-testid="org-plan">{o.planName ?? "—"}</span>
                    {o.planActive === false && <span className="ml-1.5 text-xs text-text-3">(anterior)</span>}
                    {o.priceMonthlyCents ? <div className="text-xs text-text-3">{formatMoneyCents(o.priceMonthlyCents, "PEN", "es-PE")}/mes</div> : null}
                    {o.billingProvider === "mercadopago" && (
                      <div className="text-xs text-text-3" data-testid="org-billing">
                        Mercado Pago
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5" data-testid="org-status">
                    <StatusBadge status={o.status} reason={o.statusReason} />
                    {o.cancelAtPeriodEnd && <div className="mt-0.5 text-xs text-warning-text">se cancela al corte</div>}
                  </td>
                  <td className="px-3 py-2.5" data-testid="org-period">
                    {o.status === "trialing" && o.daysLeft !== null ? (
                      <span>
                        {o.daysLeft} {o.daysLeft === 1 ? "día" : "días"}
                        <span className="text-xs text-text-3"> · {fecha(o.currentPeriodEnd)}</span>
                      </span>
                    ) : (
                      fecha(o.currentPeriodEnd)
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-text-3">{fecha(o.createdAt)}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <SearchSelect
                        value=""
                        onChange={(v) => v && onAction(o, v as SubAction)}
                        ariaLabel={`Acciones de ${o.name}`}
                        placeholder="Acciones"
                        searchPlaceholder="Buscar acción…"
                        options={acciones.map((a) => ({ value: a, label: ACTION_LABEL[a] }))}
                        className="w-36"
                        triggerClassName="h-8 text-xs"
                      />
                      <Button variant="ghost" size="sm" onClick={() => onOpen(o)} aria-label={`Ver historia de ${o.name}`}>
                        Historia
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <DataTablePagination {...table.pagination} noun={noun} label="Paginación de organizaciones" />
    </div>
  );
}

/** Para el selector de plan de una acción: los de pago (activar/reactivar) o todos. */
export function planOptions(plans: PlanDto[], onlyPaid: boolean) {
  return plans
    .filter((p) => (onlyPaid ? p.trialDays === null : true))
    .map((p) => ({ value: p.id, label: p.name, hint: p.priceMonthlyCents > 0 ? `${formatMoneyCents(p.priceMonthlyCents, p.currency, "es-PE")}/mes` : p.trialDays ? `${p.trialDays} días` : undefined }));
}
