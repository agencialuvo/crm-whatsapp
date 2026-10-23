"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Pencil, Percent, Plus, Trash2, Upload, Users } from "lucide-react";
import { ContactAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { apiFetch, describeError } from "@/components/negocio/api";
import { BulkImportDialog } from "@/components/negocio/bulk-import-dialog";
import { ConfirmDialog } from "@/components/negocio/modal";
import { StaffDialog } from "@/components/negocio/staff-dialog";
import { StaffScheduleDialog } from "@/components/negocio/staff-schedule-dialog";
import { scheduleSummary } from "@/lib/salon/format";
import { formatStaffPhone } from "@/lib/salon/staff-fields";
import type { ServiceDto, StaffDto } from "@/lib/salon/types";
import { cn } from "@/lib/utils";

type Dialog =
  | { kind: "edit"; item: StaffDto | null }
  | { kind: "config"; item: StaffDto; tab: "horario" | "comisiones" }
  | null;

/**
 * Módulo SALON — el equipo: alta de profesionales (nombre, teléfono, estado),
 * su porcentaje de comisión (50 % por defecto) y su horario semanal con los
 * días libres.
 *
 * Eliminar solo procede mientras no tenga ventas; con historial, la API
 * responde 409 y el diálogo ofrece desactivar (se conserva la caja intacta).
 */
export function StaffClient({ businessHours }: { businessHours: Record<number, string> }) {
  const [staff, setStaff] = useState<StaffDto[] | null>(null);
  // Solo para las comisiones por servicio del diálogo de configuración.
  const [services, setServices] = useState<ServiceDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [removal, setRemoval] = useState<StaffDto | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [s, c] = await Promise.all([
        apiFetch<{ staff: StaffDto[] }>("/api/negocio/equipo"),
        apiFetch<{ services: ServiceDto[] }>("/api/negocio/servicios"),
      ]);
      setStaff(s.staff);
      setServices(c.services);
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upsert = useCallback((saved: StaffDto) => {
    setStaff((prev) => {
      const list = prev ?? [];
      return list.some((s) => s.id === saved.id)
        ? list.map((s) => (s.id === saved.id ? saved : s))
        : [...list, saved];
    });
  }, []);

  async function toggleActive(member: StaffDto, active: boolean): Promise<boolean> {
    setToggling(member.id);
    setActionError(null);
    try {
      const { staff: saved } = await apiFetch<{ staff: StaffDto }>(
        `/api/negocio/equipo/${member.id}`,
        { method: "PATCH", json: { active } }
      );
      upsert(saved);
      return true;
    } catch (err) {
      setActionError(describeError(err));
      return false;
    } finally {
      setToggling(null);
    }
  }

  async function remove(member: StaffDto) {
    await apiFetch(`/api/negocio/equipo/${member.id}`, { method: "DELETE" });
    setStaff((prev) => prev?.filter((s) => s.id !== member.id) ?? prev);
  }

  // El diálogo de horario trabaja con la copia viva (se refresca al guardar a medias).
  const configTarget =
    dialog?.kind === "config" ? (staff?.find((s) => s.id === dialog.item.id) ?? dialog.item) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-text-3">
          Quienes atienden a tus clientes. Cada uno es una silla en la agenda, con su horario y su
          comisión.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setBulkOpen(true)}>
            <Upload className="h-4 w-4" aria-hidden />
            Carga masiva
          </Button>
          <Button onClick={() => setDialog({ kind: "edit", item: null })}>
            <Plus className="h-4 w-4" aria-hidden />
            Nuevo profesional
          </Button>
        </div>
      </div>

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
      ) : staff === null ? (
        <div className="space-y-2" aria-busy aria-label="Cargando">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg border bg-subtle" />
          ))}
        </div>
      ) : staff.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-card py-8">
          <EmptyState
            icon={Users}
            title="Aún no hay profesionales"
            description="Da de alta a tu primer barbero o esteticista para poder agendar y cobrar a su nombre."
            action={
              <Button onClick={() => setDialog({ kind: "edit", item: null })}>
                <Plus className="h-4 w-4" aria-hidden />
                Nuevo profesional
              </Button>
            }
          />
        </div>
      ) : (
        // `relative`: el `sr-only` de la cabecera es absoluto y, sin esto, escapa del recorte
        // del scroll y ensancha la página en el teléfono.
        <div className="relative overflow-x-auto rounded-lg border border-border-strong bg-card shadow-sm">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b bg-subtle text-left text-xs font-semibold text-text-2">
                <th scope="col" className="px-4 py-2.5">
                  Profesional
                </th>
                <th scope="col" className="px-4 py-2.5 text-right">
                  Comisión
                </th>
                <th scope="col" className="px-4 py-2.5">
                  Horario
                </th>
                <th scope="col" className="px-4 py-2.5">
                  Activo
                </th>
                <th scope="col" className="px-4 py-2.5">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {staff.map((m) => (
                <tr key={m.id} className={cn("border-b last:border-0", !m.active && "opacity-60")}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Photo url={m.imageUrl} name={m.name} seed={m.id} />
                      <div className="min-w-0">
                        <p className="font-medium">{m.name}</p>
                        {m.phone && (
                          <p className="mt-0.5 text-xs text-text-3">{formatStaffPhone(m.phone)}</p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                    {m.globalCommissionPercentage !== null ? (
                      <span className="font-medium">{m.globalCommissionPercentage}%</span>
                    ) : (
                      <span className="text-text-3">Según el servicio</span>
                    )}
                    {m.commissions.length > 0 && (
                      <p className="text-[11px] text-text-3">
                        {m.commissions.length} pacto{m.commissions.length === 1 ? "" : "s"} por servicio
                      </p>
                    )}
                  </td>
                  <td className="max-w-[16rem] px-4 py-3 text-text-2">{scheduleSummary(m.schedule)}</td>
                  <td className="px-4 py-3">
                    <Switch
                      size="sm"
                      checked={m.active}
                      disabled={toggling === m.id}
                      label={`${m.active ? "Desactivar" : "Activar"} a ${m.name}`}
                      onCheckedChange={(v) => void toggleActive(m, v)}
                    />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Horario de ${m.name}`}
                        title="Horario y días libres"
                        onClick={() => setDialog({ kind: "config", item: m, tab: "horario" })}
                      >
                        <CalendarClock className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Comisiones de ${m.name}`}
                        title="Comisiones por servicio"
                        onClick={() => setDialog({ kind: "config", item: m, tab: "comisiones" })}
                      >
                        <Percent className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Editar a ${m.name}`}
                        onClick={() => setDialog({ kind: "edit", item: m })}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Eliminar a ${m.name}`}
                        onClick={() => setRemoval(m)}
                      >
                        <Trash2 className="h-4 w-4 text-danger-text" aria-hidden />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {bulkOpen && (
        <BulkImportDialog module="equipo" onClose={() => setBulkOpen(false)} onImported={() => void load()} />
      )}

      {dialog?.kind === "edit" && (
        <StaffDialog
          item={dialog.item}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            // Una edición conserva su horario y pactos (el PATCH los devuelve).
            upsert(saved);
            setDialog(null);
          }}
        />
      )}

      {configTarget && dialog?.kind === "config" && (
        <StaffScheduleDialog
          // Remonta si cambia de persona o de pestaña inicial.
          key={`${configTarget.id}-${dialog.tab}`}
          staff={configTarget}
          services={services.filter((s) => s.active)}
          businessHours={businessHours}
          initialTab={dialog.tab}
          onClose={() => setDialog(null)}
          onSaved={upsert}
        />
      )}

      {removal && (
        <ConfirmDialog
          title="Eliminar profesional"
          message={
            <>
              ¿Eliminar a <strong>{removal.name}</strong>? Sus citas pendientes quedarán sin asignar.
              Esta acción no se puede deshacer.
            </>
          }
          confirmLabel="Eliminar"
          onClose={() => setRemoval(null)}
          onConfirm={() => remove(removal)}
          extra={({ close }) =>
            removal.active ? (
              <Button
                type="button"
                variant="outline"
                onClick={async () => {
                  if (await toggleActive(removal, false)) close();
                }}
              >
                Desactivar en su lugar
              </Button>
            ) : null
          }
        />
      )}
    </div>
  );
}

/**
 * La foto del profesional; sin foto —o si ya se borró de la galería y el archivo
 * no existe— sus iniciales sobre un color estable.
 */
function Photo({ url, name, seed }: { url: string | null; name: string; seed: string }) {
  const [roto, setRoto] = useState(false);
  return url && !roto ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={() => setRoto(true)}
      className="h-10 w-10 shrink-0 rounded-full border object-cover"
    />
  ) : (
    <ContactAvatar name={name} seed={seed} size="md" />
  );
}
