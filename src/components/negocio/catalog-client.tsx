"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, ImageIcon, Pencil, Plus, Scissors, Tag, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { apiFetch, describeError } from "@/components/negocio/api";
import { BulkImportDialog } from "@/components/negocio/bulk-import-dialog";
import { ComboDialog } from "@/components/negocio/combo-dialog";
import { ItemViewDialog } from "@/components/negocio/item-view-dialog";
import { ConfirmDialog } from "@/components/negocio/modal";
import { ServiceDialog } from "@/components/negocio/service-dialog";
import { staffPreview, type StaffOption } from "@/components/negocio/staff-select";
import { durationLabel, money } from "@/lib/salon/format";
import type { ComboDto, ServiceDto, StaffDto } from "@/lib/salon/types";
import { cn } from "@/lib/utils";

type Tab = "servicios" | "combos";

type Dialog =
  | { kind: "service"; item: ServiceDto | null }
  | { kind: "combo"; item: ComboDto | null }
  | null;

type Removal = { kind: "service"; item: ServiceDto } | { kind: "combo"; item: ComboDto };

/**
 * Módulo SALON — servicios regulares y ofertas de publicidad pagada.
 *
 * Una tabla por tipo con alta, edición, activar/desactivar en línea y
 * eliminación. Eliminar solo es posible mientras nada se haya vendido; si ya
 * hay ventas, la API responde 409 y el diálogo ofrece desactivar, que es lo
 * que conserva el historial de la caja intacto.
 */
export function CatalogClient({ currency }: { currency: string }) {
  const [tab, setTab] = useState<Tab>("servicios");
  const [services, setServices] = useState<ServiceDto[] | null>(null);
  const [combos, setCombos] = useState<ComboDto[] | null>(null);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [viewing, setViewing] = useState<Removal | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [s, c, t] = await Promise.all([
        apiFetch<{ services: ServiceDto[] }>("/api/negocio/servicios"),
        apiFetch<{ combos: ComboDto[] }>("/api/negocio/ofertas"),
        apiFetch<{ staff: StaffDto[] }>("/api/negocio/equipo"),
      ]);
      setServices(s.services);
      setCombos(c.combos);
      setStaff(t.staff.map((m) => ({ id: m.id, name: m.name, active: m.active })));
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleActive(kind: "service" | "combo", id: string, active: boolean) {
    setToggling(id);
    setActionError(null);
    try {
      if (kind === "service") {
        const { service } = await apiFetch<{ service: ServiceDto }>(
          `/api/negocio/servicios/${id}`,
          { method: "PATCH", json: { active } }
        );
        setServices((prev) => prev?.map((s) => (s.id === id ? service : s)) ?? prev);
      } else {
        const { combo } = await apiFetch<{ combo: ComboDto }>(`/api/negocio/ofertas/${id}`, {
          method: "PATCH",
          json: { active },
        });
        setCombos((prev) => prev?.map((c) => (c.id === id ? combo : c)) ?? prev);
      }
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setToggling(null);
    }
  }

  async function remove(target: Removal) {
    const base = target.kind === "service" ? "servicios" : "ofertas";
    await apiFetch(`/api/negocio/${base}/${target.item.id}`, { method: "DELETE" });
    if (target.kind === "service") {
      setServices((prev) => prev?.filter((s) => s.id !== target.item.id) ?? prev);
    } else {
      setCombos((prev) => prev?.filter((c) => c.id !== target.item.id) ?? prev);
    }
  }

  const loading = services === null && combos === null && !loadError;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div role="tablist" aria-label="Catálogo" className="flex gap-1 rounded-md bg-secondary p-1">
          <TabButton
            active={tab === "servicios"}
            onClick={() => setTab("servicios")}
            count={services?.length}
          >
            Servicios
          </TabButton>
          <TabButton
            active={tab === "combos"}
            onClick={() => setTab("combos")}
            count={combos?.length}
          >
            Ofertas
          </TabButton>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setBulkOpen(true)}>
            <Upload className="h-4 w-4" aria-hidden />
            Carga masiva
          </Button>
          <Button
            onClick={() =>
              setDialog(tab === "servicios" ? { kind: "service", item: null } : { kind: "combo", item: null })
            }
          >
            <Plus className="h-4 w-4" aria-hidden />
            {tab === "servicios" ? "Nuevo servicio" : "Nueva oferta"}
          </Button>
        </div>
      </div>

      {tab === "combos" && (
        <p className="text-sm text-text-3">
          Las ofertas son las promociones que anuncias en Meta o TikTok. La palabra clave es el texto que
          trae el mensaje que llega desde ese anuncio.
        </p>
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
      ) : loading ? (
        <ListSkeleton />
      ) : tab === "servicios" ? (
        services && services.length > 0 ? (
          <TableShell
            heads={["Servicio", "Duración", "Precio", "Comisión", "Activo", ""]}
            alignRight={[1, 2, 3]}
          >
            {services.map((s) => (
              <tr key={s.id} className={cn("border-b last:border-0", !s.active && "opacity-60")}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Thumb url={s.imageUrl} />
                    <div className="min-w-0">
                      <NameLink name={s.name} onClick={() => setViewing({ kind: "service", item: s })} />
                      {s.description && (
                        <p className="mt-0.5 max-w-xs truncate text-xs text-text-3">{s.description}</p>
                      )}
                      <p
                        className="mt-0.5 max-w-xs truncate text-xs text-text-3"
                        title={staffPreview({ kind: "service", id: s.id, staffIds: s.staffIds }, staff)}
                      >
                        {staffPreview({ kind: "service", id: s.id, staffIds: s.staffIds }, staff)}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-text-2">
                  {durationLabel(s.durationMinutes)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums">
                  {money(s.priceCents, currency)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-text-2">
                  {s.defaultCommissionPercentage}%
                </td>
                <td className="px-4 py-3">
                  <Switch
                    size="sm"
                    checked={s.active}
                    disabled={toggling === s.id}
                    label={`${s.active ? "Desactivar" : "Activar"} ${s.name}`}
                    onCheckedChange={(v) => void toggleActive("service", s.id, v)}
                  />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  <RowActions
                    name={s.name}
                    onView={() => setViewing({ kind: "service", item: s })}
                    onEdit={() => setDialog({ kind: "service", item: s })}
                    onDelete={() => setRemoval({ kind: "service", item: s })}
                  />
                </td>
              </tr>
            ))}
          </TableShell>
        ) : (
          <EmptyCard>
            <EmptyState
              icon={Scissors}
              title="Aún no hay servicios"
              description="Agrega tu primer servicio —un corte, una barba, un manicure— con su precio y duración."
              action={
                <Button onClick={() => setDialog({ kind: "service", item: null })}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Nuevo servicio
                </Button>
              }
            />
          </EmptyCard>
        )
      ) : combos && combos.length > 0 ? (
        <TableShell
          heads={["Oferta", "Palabra clave", "Duración", "Precio", "Activo", ""]}
          alignRight={[2, 3]}
        >
          {combos.map((c) => (
            <tr key={c.id} className={cn("border-b last:border-0", !c.active && "opacity-60")}>
              <td className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <Thumb url={c.imageUrl} />
                  <div className="min-w-0">
                    <NameLink name={c.name} onClick={() => setViewing({ kind: "combo", item: c })} />
                    <p className="mt-0.5 max-w-xs truncate text-xs text-text-3">{c.description}</p>
                    <p
                      className="mt-0.5 max-w-xs truncate text-xs text-text-3"
                      title={staffPreview({ kind: "combo", id: c.id, staffIds: c.staffIds }, staff)}
                    >
                      {staffPreview({ kind: "combo", id: c.id, staffIds: c.staffIds }, staff)}
                    </p>
                  </div>
                </div>
              </td>
              <td className="px-4 py-3">
                {c.keywordTrigger ? (
                  <Badge variant="secondary" className="font-mono">
                    {c.keywordTrigger}
                  </Badge>
                ) : (
                  <span className="text-text-3">—</span>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-text-2">
                {durationLabel(c.durationMinutes)}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums">
                {money(c.priceCents, currency)}
              </td>
              <td className="px-4 py-3">
                <Switch
                  size="sm"
                  checked={c.active}
                  disabled={toggling === c.id}
                  label={`${c.active ? "Desactivar" : "Activar"} ${c.name}`}
                  onCheckedChange={(v) => void toggleActive("combo", c.id, v)}
                />
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right">
                <RowActions
                  name={c.name}
                  onView={() => setViewing({ kind: "combo", item: c })}
                  onEdit={() => setDialog({ kind: "combo", item: c })}
                  onDelete={() => setRemoval({ kind: "combo", item: c })}
                />
              </td>
            </tr>
          ))}
        </TableShell>
      ) : (
        <EmptyCard>
          <EmptyState
            icon={Tag}
            title="Aún no hay ofertas"
            description="Crea la oferta que anuncias —por ejemplo «Oferta Fresh»— y la palabra clave con la que te escriben desde el anuncio."
            action={
              <Button onClick={() => setDialog({ kind: "combo", item: null })}>
                <Plus className="h-4 w-4" aria-hidden />
                Nueva oferta
              </Button>
            }
          />
        </EmptyCard>
      )}

      {dialog?.kind === "service" && (
        <ServiceDialog
          item={dialog.item}
          currency={currency}
          staff={staff}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setServices((prev) => {
              const list = prev ?? [];
              const exists = list.some((s) => s.id === saved.id);
              const next = exists ? list.map((s) => (s.id === saved.id ? saved : s)) : [...list, saved];
              return next.sort((a, b) => a.name.localeCompare(b.name, "es"));
            });
            setDialog(null);
          }}
        />
      )}
      {bulkOpen && (
        <BulkImportDialog module="servicios" onClose={() => setBulkOpen(false)} onImported={() => void load()} />
      )}

      {dialog?.kind === "combo" && (
        <ComboDialog
          item={dialog.item}
          currency={currency}
          staff={staff}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setCombos((prev) => {
              const list = prev ?? [];
              const exists = list.some((c) => c.id === saved.id);
              const next = exists ? list.map((c) => (c.id === saved.id ? saved : c)) : [...list, saved];
              return next.sort((a, b) => a.name.localeCompare(b.name, "es"));
            });
            setDialog(null);
          }}
        />
      )}

      {viewing && (
        <ItemViewDialog
          target={viewing}
          currency={currency}
          staff={staff}
          onClose={() => setViewing(null)}
        />
      )}

      {removal && (
        <ConfirmDialog
          title={removal.kind === "service" ? "Eliminar servicio" : "Eliminar oferta"}
          message={
            <>
              ¿Eliminar <strong>{removal.item.name}</strong>? Esta acción no se puede deshacer.
            </>
          }
          confirmLabel="Eliminar"
          onClose={() => setRemoval(null)}
          onConfirm={() => remove(removal)}
          extra={({ close, setError }) =>
            removal.item.active ? (
              <Button
                type="button"
                variant="outline"
                onClick={async () => {
                  try {
                    await toggleActive(removal.kind, removal.item.id, false);
                    close();
                  } catch (err) {
                    setError(describeError(err));
                  }
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

function TabButton({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-[13.5px] font-semibold transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-background text-foreground shadow-sm" : "text-text-2 hover:text-foreground"
      )}
    >
      {children}
      {count !== undefined && (
        <span className="rounded-full bg-chip px-1.5 text-[11px] font-medium text-text-2">
          {count}
        </span>
      )}
    </button>
  );
}

function TableShell({
  heads,
  alignRight = [],
  children,
}: {
  heads: string[];
  alignRight?: number[];
  children: React.ReactNode;
}) {
  return (
    // `relative`: el texto `sr-only` de la cabecera es absoluto; sin esto escapa del
    // recorte del scroll y ensancha la página en el teléfono.
    <div className="relative overflow-x-auto rounded-lg border border-border-strong bg-card shadow-sm">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b bg-subtle text-left">
            {heads.map((h, i) => (
              <th
                key={`${h}-${i}`}
                scope="col"
                className={cn(
                  "px-4 py-2.5 text-xs font-semibold text-text-2",
                  alignRight.includes(i) && "text-right"
                )}
              >
                {h || <span className="sr-only">Acciones</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/**
 * La miniatura de la imagen del servicio u oferta; sin imagen —o si ya se borró
 * de la galería y el archivo no existe— un recuadro neutro.
 */
function Thumb({ url }: { url: string | null }) {
  const [roto, setRoto] = useState(false);
  return url && !roto ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={() => setRoto(true)}
      className="h-10 w-10 shrink-0 rounded-md border object-cover"
    />
  ) : (
    <span
      aria-hidden
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-subtle text-text-3"
    >
      <ImageIcon className="h-4 w-4" strokeWidth={1.6} />
    </span>
  );
}

/** El nombre es un enlace a la información del servicio u oferta (igual que el ojo). */
function NameLink({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm text-left font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {name}
    </button>
  );
}

function RowActions({
  name,
  onView,
  onEdit,
  onDelete,
}: {
  name: string;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex justify-end gap-1">
      <Button variant="ghost" size="icon" aria-label={`Ver ${name}`} onClick={onView}>
        <Eye className="h-4 w-4" aria-hidden />
      </Button>
      <Button variant="ghost" size="icon" aria-label={`Editar ${name}`} onClick={onEdit}>
        <Pencil className="h-4 w-4" aria-hidden />
      </Button>
      <Button variant="ghost" size="icon" aria-label={`Eliminar ${name}`} onClick={onDelete}>
        <Trash2 className="h-4 w-4 text-danger-text" aria-hidden />
      </Button>
    </div>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong bg-card py-8">{children}</div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2" aria-busy aria-label="Cargando">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-14 animate-pulse rounded-lg border bg-subtle" />
      ))}
    </div>
  );
}
