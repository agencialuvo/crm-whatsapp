"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { dayShort, WEEK_ORDER } from "@/lib/salon/format";
import { DAY_NAMES, commissionOverridesSchema, scheduleInputSchema } from "@/lib/salon/schemas";
import type { ServiceDto, StaffDto } from "@/lib/salon/types";
import { cn } from "@/lib/utils";
import { SearchSelect } from "@/components/ui/search-select";

type Mode = "negocio" | "libre" | "custom";
type DayRow = { dayOfWeek: number; mode: Mode; start: string; end: string };

const DEFAULT_START = "09:00";
const DEFAULT_END = "18:00";

function rowsFrom(staff: StaffDto): DayRow[] {
  return WEEK_ORDER.map((dayOfWeek) => {
    const found = staff.schedule.find((d) => d.dayOfWeek === dayOfWeek);
    if (!found) return { dayOfWeek, mode: "negocio", start: DEFAULT_START, end: DEFAULT_END };
    return {
      dayOfWeek,
      mode: found.isOff ? "libre" : "custom",
      start: found.startTime,
      end: found.endTime,
    };
  });
}

/**
 * Módulo SALON — horario semanal y comisiones por servicio de un profesional.
 *
 * Horario: cada día sigue el del negocio, es libre, o tiene horas propias. Solo
 * se guardan los dos últimos casos; el resto no deja fila (así, si el negocio
 * cambia su horario, quien lo sigue lo sigue).
 *
 * Comisiones: el porcentaje global del profesional y, opcionalmente, uno
 * pactado por servicio. Orden de prioridad al cobrar: la venta → este pacto →
 * el global → el del servicio → 50 %.
 */
const MODE_OPTIONS = [
  { value: "negocio", label: "Horario del negocio" },
  { value: "libre", label: "Día libre" },
  { value: "custom", label: "Horas propias" },
];

export function StaffScheduleDialog({
  staff,
  services,
  businessHours,
  initialTab = "horario",
  onClose,
  onSaved,
}: {
  staff: StaffDto;
  services: ServiceDto[];
  /** Resumen del horario del negocio por día (0 = domingo). */
  businessHours: Record<number, string>;
  initialTab?: "horario" | "comisiones";
  onClose: () => void;
  /** Se llama con lo último guardado; el diálogo se cierra al terminar ambos. */
  onSaved: (staff: StaffDto) => void;
}) {
  const [tab, setTab] = useState<"horario" | "comisiones">(initialTab);
  const [rows, setRows] = useState<DayRow[]>(() => rowsFrom(staff));
  const [global, setGlobal] = useState(staff.globalCommissionPercentage?.toString() ?? "");
  const [overrides, setOverrides] = useState<Record<string, string>>(() =>
    Object.fromEntries(staff.commissions.map((c) => [c.serviceId, String(c.percentage)]))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scheduleDirty = useMemo(
    () => JSON.stringify(rows) !== JSON.stringify(rowsFrom(staff)),
    [rows, staff]
  );

  function patchRow(dayOfWeek: number, patch: Partial<DayRow>) {
    setRows((prev) => prev.map((r) => (r.dayOfWeek === dayOfWeek ? { ...r, ...patch } : r)));
  }

  async function save() {
    setError(null);

    const scheduleParsed = scheduleInputSchema.safeParse({
      days: rows
        .filter((r) => r.mode !== "negocio")
        .map((r) => ({
          dayOfWeek: r.dayOfWeek,
          isOff: r.mode === "libre",
          startTime: r.mode === "libre" ? DEFAULT_START : r.start,
          endTime: r.mode === "libre" ? DEFAULT_END : r.end,
        })),
    });
    if (!scheduleParsed.success) {
      setTab("horario");
      setError(scheduleParsed.error.issues[0]?.message ?? "Revisa el horario");
      return;
    }

    const globalNumber = global.trim() === "" ? null : Number(global);
    if (globalNumber !== null && (!Number.isInteger(globalNumber) || globalNumber < 0 || globalNumber > 100)) {
      setTab("comisiones");
      setError("El porcentaje global debe ser un entero entre 0 y 100");
      return;
    }
    const overridesParsed = commissionOverridesSchema.safeParse({
      overrides: Object.entries(overrides)
        .filter(([, v]) => v.trim() !== "")
        .map(([serviceId, v]) => ({ serviceId, percentage: Number(v) })),
    });
    if (!overridesParsed.success) {
      setTab("comisiones");
      setError(
        overridesParsed.error.issues[0]?.message?.includes("Expected")
          ? "Cada comisión por servicio debe ser un entero entre 0 y 100"
          : (overridesParsed.error.issues[0]?.message ?? "Revisa las comisiones")
      );
      return;
    }

    setBusy(true);
    let latest = staff;
    try {
      // Solo se llama a lo que cambió: un guardado parcial no pisa nada ajeno.
      if (scheduleDirty) {
        latest = (
          await apiFetch<{ staff: StaffDto }>(`/api/negocio/equipo/${staff.id}/horario`, {
            method: "PUT",
            json: scheduleParsed.data,
          })
        ).staff;
        onSaved(latest);
      }
      if (globalNumber !== latest.globalCommissionPercentage) {
        latest = (
          await apiFetch<{ staff: StaffDto }>(`/api/negocio/equipo/${staff.id}`, {
            method: "PATCH",
            json: { globalCommissionPercentage: globalNumber },
          })
        ).staff;
        onSaved(latest);
      }
      const before = JSON.stringify(
        [...latest.commissions].sort((a, b) => a.serviceId.localeCompare(b.serviceId))
      );
      const after = JSON.stringify(
        [...overridesParsed.data.overrides].sort((a, b) => a.serviceId.localeCompare(b.serviceId))
      );
      if (before !== after) {
        latest = (
          await apiFetch<{ staff: StaffDto }>(`/api/negocio/equipo/${staff.id}/comisiones`, {
            method: "PUT",
            json: overridesParsed.data,
          })
        ).staff;
        onSaved(latest);
      }
      onClose();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Horario y comisiones · ${staff.name}`}
      description="Los días que no cambies siguen el horario del negocio."
      onClose={onClose}
      busy={busy}
      size="lg"
    >
      <div role="tablist" aria-label="Configuración" className="mb-4 flex w-fit gap-1 rounded-md bg-secondary p-1">
        {(
          [
            ["horario", "Horario semanal"],
            ["comisiones", "Comisiones"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "rounded-sm px-3 py-1.5 text-[13.5px] font-semibold transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === id ? "bg-background text-foreground shadow-sm" : "text-text-2 hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "horario" ? (
        <ul className="divide-y rounded-md border">
          {rows.map((r) => (
            <li key={r.dayOfWeek} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
              <div className="w-24 shrink-0">
                <p className="text-sm font-medium">{DAY_NAMES[r.dayOfWeek]}</p>
                <p className="text-[11px] text-text-3">Negocio: {businessHours[r.dayOfWeek] ?? "—"}</p>
              </div>
              <SearchSelect
                ariaLabel={`${DAY_NAMES[r.dayOfWeek]}: tipo de horario`}
                value={r.mode}
                onChange={(v) => patchRow(r.dayOfWeek, { mode: v as Mode })}
                options={MODE_OPTIONS}
                searchPlaceholder="Buscar…"
                disabled={busy}
                className="w-44"
              />
              {r.mode === "custom" && (
                <div className="flex items-center gap-1.5">
                  <Input
                    type="time"
                    aria-label={`${dayShort(r.dayOfWeek)}: entrada`}
                    value={r.start}
                    onChange={(e) => patchRow(r.dayOfWeek, { start: e.target.value })}
                    disabled={busy}
                    className="w-28"
                  />
                  <span aria-hidden className="text-text-3">
                    a
                  </span>
                  <Input
                    type="time"
                    aria-label={`${dayShort(r.dayOfWeek)}: salida`}
                    value={r.end}
                    onChange={(e) => patchRow(r.dayOfWeek, { end: e.target.value })}
                    disabled={busy}
                    className="w-28"
                  />
                </div>
              )}
              {r.mode === "libre" && <span className="text-sm text-text-3">No atiende este día</span>}
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="comm-global" className="text-sm font-medium">
              Comisión global (%)
            </label>
            <Input
              id="comm-global"
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              step={1}
              value={global}
              onChange={(e) => setGlobal(e.target.value)}
              disabled={busy}
              className="w-32"
            />
            <p className="text-xs text-text-3">
              Para todos los servicios sin un pacto propio. Vacío: manda el porcentaje de cada servicio.
            </p>
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium">Pactos por servicio</p>
            {services.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-text-3">
                Aún no hay servicios. Créalos en «Servicios».
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {services.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <label htmlFor={`comm-${s.id}`} className="min-w-0 flex-1 truncate text-sm">
                      {s.name}
                    </label>
                    <div className="flex items-center gap-1.5">
                      <Input
                        id={`comm-${s.id}`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={100}
                        step={1}
                        placeholder={global.trim() || String(s.defaultCommissionPercentage)}
                        value={overrides[s.id] ?? ""}
                        onChange={(e) => setOverrides((prev) => ({ ...prev, [s.id]: e.target.value }))}
                        disabled={busy}
                        className="w-20"
                      />
                      <span aria-hidden className="text-sm text-text-3">
                        %
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1.5 text-xs text-text-3">
              Déjalo vacío para usar la regla de siempre. El gris muestra el porcentaje que se aplicaría.
            </p>
          </div>
        </div>
      )}

      <ModalFooter error={error}>
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button type="button" onClick={() => void save()} disabled={busy}>
          {busy ? "Guardando…" : "Guardar"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
