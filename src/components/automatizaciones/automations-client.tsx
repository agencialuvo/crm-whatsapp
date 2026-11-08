"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Plus, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTablePagination, DataTableToolbar } from "@/components/ui/data-table-pagination";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { useDataTable } from "@/components/ui/use-data-table";
import { FlowDialog } from "@/components/automatizaciones/flow-dialog";
import { RefreshButton, StatsPanel, useAutomationStats } from "@/components/automatizaciones/stats-panel";
import { apiFetch, describeError } from "@/components/negocio/api";
import { activationBlock, triggerLabel, type FlowListItem, type StageOption } from "@/lib/automation-dto";

/** Lista vacía estable mientras los flujos cargan. */
const NONE: never[] = [];

/**
 * Automatizaciones — los flujos del negocio: cuáles hay, cuándo se activan, cuántos pasos tienen y si están
 * encendidos. Desde aquí se crea uno nuevo (y se pasa a su detalle para armarlo) y se enciende o apaga
 * sin abrirlo.
 *
 * Encender exige al menos un paso: el interruptor lo avisa antes de pedirlo, y si el servidor lo rechazara
 * igual, su mensaje se muestra tal cual.
 */
export function AutomationsClient() {
  const router = useRouter();
  const [flows, setFlows] = useState<FlowListItem[] | null>(null);
  const [stages, setStages] = useState<StageOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const table = useDataTable(flows ?? NONE, { view: "automatizaciones" });
  const monitor = useAutomationStats(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [list, st] = await Promise.all([
        apiFetch<{ flows: FlowListItem[] }>("/api/automations"),
        // Las etapas solo sirven para el formulario: si fallan, la lista se muestra igual.
        apiFetch<{ stages: StageOption[] }>("/api/pipeline/stages").catch(() => ({ stages: [] as StageOption[] })),
      ]);
      setFlows(list.flows);
      setStages(st.stages);
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(flow: FlowListItem, active: boolean) {
    setActionError(null);
    // La misma regla del servidor, avisada antes de pedirla.
    const block = active ? activationBlock(flow.stepCount, flow.active) : null;
    if (block) {
      setActionError(`«${flow.name}»: ${block}`);
      return;
    }
    setToggling(flow.id);
    try {
      await apiFetch(`/api/automations/${flow.id}`, { method: "PATCH", json: { active } });
      setFlows((prev) => prev?.map((f) => (f.id === flow.id ? { ...f, active } : f)) ?? prev);
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setToggling(null);
    }
  }

  const newButton = (
    <Button onClick={() => setCreating(true)}>
      <Plus className="h-4 w-4" aria-hidden />
      Crear nuevo flujo
    </Button>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-text-3">
          Mensajes y esperas que se ejecutan solos cuando pasa algo con un cliente: su cumpleaños, un cambio de
          etapa o un lead nuevo.
        </p>
        {newButton}
      </div>

      {flows !== null && flows.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-[15px] font-bold tracking-tight">Estado del motor</h3>
            <RefreshButton
              loading={monitor.loading}
              updatedAt={monitor.updatedAt}
              onClick={() => void monitor.reload()}
            />
          </div>
          <StatsPanel
            stats={monitor.stats}
            error={monitor.error}
            loading={monitor.loading}
            onRetry={() => void monitor.reload()}
            scope="de tus flujos"
          />
        </div>
      )}

      {actionError && (
        <p
          role="alert"
          className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text"
        >
          {actionError}
        </p>
      )}

      {loadError ? (
        <div className="rounded-lg border border-danger-soft bg-danger-tint p-4 text-sm text-danger-text">
          <p>{loadError}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
            Reintentar
          </Button>
        </div>
      ) : flows === null ? (
        <div className="space-y-2" aria-busy aria-label="Cargando">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg border bg-subtle" />
          ))}
        </div>
      ) : flows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-card py-8">
          <EmptyState
            icon={Zap}
            title="Aún no tienes automatizaciones"
            description="Crea tu primer flujo, por ejemplo un saludo automático el día del cumpleaños de tus clientes."
            action={newButton}
          />
        </div>
      ) : (
        <>
          <DataTableToolbar {...table.pagination} noun={{ one: "flujo", other: "flujos" }} />
          <div className="relative overflow-x-auto rounded-lg border border-border-strong bg-card shadow-sm">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b bg-subtle text-left text-xs font-semibold text-text-2">
                  <th scope="col" className="px-4 py-2.5">
                    Nombre
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    Disparador
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    Pasos
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    Estado
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    <span className="sr-only">Abrir</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {table.rows.map((f) => {
                  const block = activationBlock(f.stepCount, f.active);
                  return (
                    <tr key={f.id} className="border-b last:border-0">
                      <td className="px-4 py-3">
                        <Link
                          href={`/automatizaciones/${f.id}`}
                          className="font-medium underline-offset-2 hover:underline focus-visible:underline"
                        >
                          {f.name}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <Badge variant="secondary">{triggerLabel(f.triggerType)}</Badge>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{f.stepCount}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <Switch
                            size="sm"
                            checked={f.active}
                            // Sin pasos no se puede encender; apagar siempre se puede.
                            disabled={toggling === f.id || block !== null}
                            label={`${f.active ? "Apagar" : "Encender"} «${f.name}»`}
                            onCheckedChange={(v) => void toggle(f, v)}
                          />
                          <span className="text-xs">
                            {f.active ? (
                              <Badge variant="success">Activo</Badge>
                            ) : (
                              <Badge variant="secondary">Pausado</Badge>
                            )}
                          </span>
                        </div>
                        {block && <p className="mt-1 text-[11px] text-text-3">Sin pasos: agrégalos para encenderlo.</p>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Abrir «${f.name}»`}
                          onClick={() => router.push(`/automatizaciones/${f.id}`)}
                        >
                          <ChevronRight className="h-4 w-4" aria-hidden />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <DataTablePagination
            {...table.pagination}
            noun={{ one: "flujo", other: "flujos" }}
            label="Paginación de las automatizaciones"
          />
        </>
      )}

      {creating && (
        <FlowDialog
          flow={null}
          stages={stages}
          onClose={() => setCreating(false)}
          // Recién creado está vacío: se va a su detalle para agregarle pasos.
          onSaved={(flow) => router.push(`/automatizaciones/${flow.id}`)}
        />
      )}
    </div>
  );
}
