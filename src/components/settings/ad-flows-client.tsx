"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTablePagination, DataTableToolbar } from "@/components/ui/data-table-pagination";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchInput } from "@/components/ui/search-input";
import { SearchSelect } from "@/components/ui/search-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useDataTable } from "@/components/ui/use-data-table";
import { MiniaturaDeAnuncio } from "@/components/anuncio-origen";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Field, fieldErrors } from "@/components/negocio/fields";
import { ConfirmDialog, Modal, ModalFooter } from "@/components/negocio/modal";
import {
  AD_FLOW_RULES_MAX,
  adFlowSchema,
  type AdFlowDto,
  type AdFlowListDto,
  type AdFlowRowDto,
  type AdFlowTargetKind,
  type CatalogAdOption,
} from "@/lib/ad-flow";
import { titularDeOrigen } from "@/lib/anuncios";
import { matchesQuery } from "@/lib/search";
import type { ComboDto, ServiceDto } from "@/lib/salon/types";

const AD_NOUN = { one: "anuncio", other: "anuncios" };
/** Lista vacía estable mientras carga (así `useDataTable` no recalcula en cada render). */
const NONE: AdFlowRowDto[] = [];

type Editing = AdFlowRowDto | "new" | null;

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Ajustes → Anuncios: enrutamiento por anuncio. Cada anuncio de Meta del que han llegado conversaciones
 * aparece aquí; se vincula a UN servicio u oferta para que el agente persiga su conversión, con reglas
 * propias y, si se quiere, en modo exclusivo (no ofrece otros servicios por su cuenta).
 */
export function AdFlowsClient() {
  const [data, setData] = useState<AdFlowListDto | null>(null);
  const [services, setServices] = useState<ServiceDto[]>([]);
  const [combos, setCombos] = useState<ComboDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<AdFlowDto | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, s, c] = await Promise.all([
        apiFetch<AdFlowListDto>("/api/settings/ad-flows"),
        // El catálogo es del módulo del salón: si no está, la lista de destinos queda vacía y se avisa.
        apiFetch<{ services: ServiceDto[] }>("/api/negocio/servicios").catch(() => ({ services: [] as ServiceDto[] })),
        apiFetch<{ combos: ComboDto[] }>("/api/negocio/ofertas").catch(() => ({ combos: [] as ComboDto[] })),
      ]);
      setData(list);
      setServices(s.services);
      setCombos(c.combos);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () =>
      (data?.items ?? NONE).filter((r) =>
        matchesQuery(query, { text: [r.headline, r.sourceId, r.flow?.targetName] })
      ),
    [data, query]
  );
  const table = useDataTable(filtered, { view: "anuncios-flujos", resetKey: query });

  async function remove(flow: AdFlowDto) {
    await apiFetch(`/api/settings/ad-flows/${flow.id}`, { method: "DELETE" });
    setNotice("Flujo quitado. Ese anuncio vuelve al comportamiento genérico.");
    await load();
  }

  const items = data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Enrutamiento por anuncio</CardTitle>
        <CardDescription>
          Elige qué servicio u oferta persigue el agente cuando alguien llega desde un anuncio. Con el modo
          exclusivo no ofrece otros servicios por su cuenta, y si el cliente insiste en otro, pasa con una
          persona. Un anuncio sin flujo se atiende como siempre.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Buscar por titular, ID o servicio..."
            ariaLabel="Buscar anuncios"
            className="max-w-xs"
          />
          <Button onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" aria-hidden />
            Vincular anuncio
          </Button>
        </div>

        {notice && (
          <p
            role="status"
            className="rounded-md border border-success-soft bg-success-tint px-3 py-2 text-sm text-success-text"
          >
            {notice}
          </p>
        )}

        {error ? (
          <div className="rounded-lg border border-danger-soft bg-danger-tint p-4 text-sm text-danger-text">
            <p>{error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
              Reintentar
            </Button>
          </div>
        ) : data === null ? (
          <div className="space-y-2" aria-busy aria-label="Cargando anuncios">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg border bg-subtle" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-text-2">
            Todavía no ha llegado nadie desde un anuncio. Aparecerán aquí cuando alguien escriba desde uno;
            también puedes vincular uno ya con su ID.
          </p>
        ) : filtered.length === 0 ? (
          <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-text-2">
            No se encontraron resultados.
          </p>
        ) : (
          <>
            {data.truncated && (
              <p className="rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
                Se muestran los anuncios más recientes. Usa la búsqueda o vincula uno por su ID.
              </p>
            )}
            <DataTableToolbar {...table.pagination} noun={AD_NOUN} />
            {/* Teléfono: una tarjeta por anuncio, sin scroll lateral. */}
            <ul className="divide-y rounded-lg border border-border-strong bg-card sm:hidden">
              {table.rows.map((r) => (
                <li key={r.sourceId} className="space-y-2 px-3 py-3" data-anuncio={r.sourceId}>
                  <NombreAnuncio r={r} />
                  <p className="text-xs text-text-3">
                    {r.conversations} {r.conversations === 1 ? "conversación" : "conversaciones"}
                    {r.flow?.targetName ? ` · ${r.flow.targetName}` : ""}
                  </p>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <EstadoFlujo r={r} />
                    <AccionesFlujo r={r} onEdit={() => setEditing(r)} onRemove={() => r.flow && setRemoving(r.flow)} />
                  </div>
                </li>
              ))}
            </ul>

            <div className="relative hidden overflow-x-auto rounded-lg border border-border-strong bg-card sm:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-subtle text-left text-xs font-semibold text-text-2">
                    <th scope="col" className="px-4 py-2.5">Anuncio</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Conversaciones</th>
                    <th scope="col" className="px-4 py-2.5">Servicio u oferta</th>
                    <th scope="col" className="px-4 py-2.5">Estado</th>
                    <th scope="col" className="px-4 py-2.5">
                      <span className="sr-only">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((r) => (
                    <tr key={r.sourceId} className="border-b last:border-0" data-anuncio={r.sourceId}>
                      <td className="px-4 py-3">
                        <NombreAnuncio r={r} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                        {r.conversations}
                        {r.lastSeenAt && (
                          <span className="block text-[11px] text-text-3">Último: {dayLabel(r.lastSeenAt)}</span>
                        )}
                      </td>
                      <td className="max-w-[14rem] truncate px-4 py-3 text-text-2">
                        {r.flow?.targetName ?? <span className="text-text-3">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <EstadoFlujo r={r} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <AccionesFlujo r={r} onEdit={() => setEditing(r)} onRemove={() => r.flow && setRemoving(r.flow)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DataTablePagination {...table.pagination} noun={AD_NOUN} label="Paginación de anuncios" />
          </>
        )}
      </CardContent>

      {editing && (
        <AdFlowDialog
          row={editing === "new" ? null : editing}
          services={services}
          combos={combos}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice("Flujo guardado.");
            void load();
          }}
        />
      )}

      {removing && (
        <ConfirmDialog
          title="Quitar flujo"
          message={
            <>
              ¿Quitar el flujo del anuncio <strong>{removing.headline ?? removing.sourceId}</strong>? El agente
              dejará de enrutar sus conversaciones y lo atenderá como un anuncio común.
            </>
          }
          confirmLabel="Quitar flujo"
          onClose={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        />
      )}
    </Card>
  );
}

/**
 * Cómo se llama el anuncio. Con la cuenta publicitaria conectada es lo que el dueño ve en Meta (anuncio, y
 * debajo «Campaña › Conjunto»); sin ella, el titular del creativo de siempre. El ID queda como detalle.
 */
function NombreAnuncio({ r }: { r: AdFlowRowDto }) {
  const ruta = [r.campaignName, r.adsetName].filter(Boolean).join(" › ");
  const principal = r.adName ?? titularDeOrigen(r.headline, r.sourceType);
  const detalle = r.adName && r.headline && r.headline !== r.adName ? `Creativo: ${r.headline} · ` : "";
  return (
    <div className="flex items-center gap-3">
      <MiniaturaDeAnuncio imageAssetId={r.imageAssetId} alt={`Creativo: ${titularDeOrigen(r.headline, r.sourceType)}`} />
      <div className="min-w-0">
        <p className="truncate font-medium sm:max-w-xs" title={principal}>
          {principal}
          {r.effectiveStatus && r.effectiveStatus !== "ACTIVE" && /PAUSED/.test(r.effectiveStatus) ? (
            <Badge variant="warning" className="ml-1.5 align-middle">
              Pausado en Meta
            </Badge>
          ) : null}
        </p>
        {ruta && (
          <p className="truncate text-[11px] text-text-2 sm:max-w-xs" title={ruta} data-jerarquia>
            {ruta}
          </p>
        )}
        <p className="truncate font-mono text-[11px] text-text-3 sm:max-w-xs" title={r.sourceId}>
          {detalle}ID {r.sourceId}
        </p>
      </div>
    </div>
  );
}

function EstadoFlujo({ r }: { r: AdFlowRowDto }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {!r.flow ? (
        <Badge variant="secondary">Sin configurar</Badge>
      ) : r.flow.active ? (
        <Badge variant="success">Activo</Badge>
      ) : (
        <Badge variant="warning">Pausado</Badge>
      )}
      {r.flow?.exclusive && <Badge variant="outline">Exclusivo</Badge>}
    </div>
  );
}

function AccionesFlujo({ r, onEdit, onRemove }: { r: AdFlowRowDto; onEdit: () => void; onRemove: () => void }) {
  return (
    <div className="flex justify-end gap-1">
      <Button
        variant={r.flow ? "ghost" : "outline"}
        size={r.flow ? "icon" : "sm"}
        aria-label={`${r.flow ? "Editar" : "Configurar"} el flujo del anuncio ${r.sourceId}`}
        title={r.flow ? "Editar flujo" : "Configurar"}
        onClick={onEdit}
      >
        {r.flow ? <Pencil className="h-4 w-4" aria-hidden /> : "Configurar"}
      </Button>
      {r.flow && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Quitar el flujo del anuncio ${r.sourceId}`}
          title="Quitar flujo"
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4 text-danger-text" aria-hidden />
        </Button>
      )}
    </div>
  );
}

/** Vincular o editar el flujo de un anuncio. Valida con el MISMO esquema Zod que la API. */
function AdFlowDialog({
  row,
  services,
  combos,
  onClose,
  onSaved,
}: {
  /** null = vincular uno nuevo a mano, escribiendo su ID. */
  row: AdFlowRowDto | null;
  services: ServiceDto[];
  combos: ComboDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const flow = row?.flow ?? null;
  const [sourceId, setSourceId] = useState(row?.sourceId ?? "");
  const [headline, setHeadline] = useState(flow?.headline ?? row?.headline ?? "");
  const [kind, setKind] = useState<AdFlowTargetKind | "">(
    flow?.serviceId ? "service" : flow?.comboId ? "combo" : ""
  );
  const [targetId, setTargetId] = useState(flow?.serviceId ?? flow?.comboId ?? "");
  const [exclusive, setExclusive] = useState(flow?.exclusive ?? true);
  const [active, setActive] = useState(flow?.active ?? true);
  const [rules, setRules] = useState(flow?.promptRules ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 039 — Con la cuenta publicitaria conectada se elige el anuncio de una lista (con sus nombres de Meta); el
  // ID a mano sigue disponible para uno que no esté en ella.
  const [catalog, setCatalog] = useState<CatalogAdOption[] | null>(null);
  const [manualId, setManualId] = useState(false);
  useEffect(() => {
    if (row) return;
    void apiFetch<{ ads: CatalogAdOption[] }>("/api/settings/ad-flows/catalog")
      .then((r) => setCatalog(r.ads))
      .catch(() => setCatalog([]));
  }, [row]);
  const hayCatalogo = !row && !!catalog && catalog.length > 0 && !manualId;

  // Solo lo activo se puede elegir, salvo lo ya vinculado (aunque se haya desactivado después).
  const targetOptions = useMemo(() => {
    const list = kind === "service" ? services : kind === "combo" ? combos : [];
    return list
      .filter((x) => x.active || x.id === targetId)
      .map((x) => ({ value: x.id, label: x.active ? x.name : `${x.name} (inactivo)` }));
  }, [kind, services, combos, targetId]);
  const noCatalog = services.length === 0 && combos.length === 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = adFlowSchema.safeParse({
      sourceId,
      headline,
      serviceId: kind === "service" ? targetId : null,
      comboId: kind === "combo" ? targetId : null,
      promptRules: rules,
      active,
      exclusive,
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await apiFetch("/api/settings/ad-flows", { method: "POST", json: parsed.data });
      onSaved();
    } catch (err) {
      setFormError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={flow ? "Editar flujo del anuncio" : "Configurar anuncio"}
      description="Cuando alguien llegue desde este anuncio, el agente perseguirá el servicio u oferta que elijas."
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field
          label="ID del anuncio"
          required
          htmlFor="adflow-source"
          error={errors.sourceId}
          hint={
            row
              ? undefined
              : hayCatalogo
                ? "Los anuncios de tu cuenta publicitaria. Si no aparece, escribe su ID a mano."
                : "Lo ves en la tarjeta «Llegó por un anuncio» de la bandeja."
          }
        >
          {hayCatalogo ? (
            <SearchSelect
              id="adflow-source"
              value={sourceId}
              onChange={(v) => {
                if (v === "__manual__") {
                  setManualId(true);
                  setSourceId("");
                  return;
                }
                setSourceId(v);
                const elegido = catalog?.find((a) => a.adId === v);
                if (elegido && !headline) setHeadline(elegido.label.split(" › ").pop() ?? "");
              }}
              options={[
                ...(catalog ?? []).map((a) => ({
                  value: a.adId,
                  label: `${a.label}${a.effectiveStatus && a.effectiveStatus !== "ACTIVE" ? " (pausado)" : ""}`,
                })),
                { value: "__manual__", label: "Escribir el ID a mano…" },
              ]}
              placeholder="Elige un anuncio"
              searchPlaceholder="Buscar por campaña, conjunto o anuncio…"
              disabled={busy}
              invalid={!!errors.sourceId}
            />
          ) : (
            <Input
              id="adflow-source"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              disabled={busy || !!row}
              maxLength={128}
              className="font-mono"
              aria-invalid={!!errors.sourceId}
            />
          )}
        </Field>

        <Field label="Nombre para reconocerlo" htmlFor="adflow-headline" error={errors.headline} hint="Opcional.">
          <Input
            id="adflow-headline"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            disabled={busy}
            maxLength={300}
            placeholder="Ej. Promo corte + barba"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Vincular a" htmlFor="adflow-kind">
            <SearchSelect
              id="adflow-kind"
              value={kind}
              onChange={(v) => {
                setKind(v as AdFlowTargetKind | "");
                setTargetId("");
              }}
              options={[
                { value: "service", label: "Un servicio" },
                { value: "combo", label: "Una oferta" },
              ]}
              emptyLabel="Nada (solo reglas)"
              emptyShowsPlaceholder
              placeholder="Nada (solo reglas)"
              searchPlaceholder="Buscar…"
              disabled={busy}
            />
          </Field>
          <Field
            label={kind === "combo" ? "Oferta" : "Servicio"}
            htmlFor="adflow-target"
            error={errors.serviceId ?? errors.comboId}
          >
            <SearchSelect
              id="adflow-target"
              value={targetId}
              onChange={setTargetId}
              options={targetOptions}
              placeholder={kind ? "Elige…" : "Primero elige qué vincular"}
              searchPlaceholder="Buscar…"
              disabled={busy || !kind}
              invalid={!!(errors.serviceId ?? errors.comboId)}
            />
          </Field>
        </div>
        {noCatalog && (
          <p className="text-xs text-text-3">
            No hay servicios ni ofertas para vincular todavía.{" "}
            <Link href="/servicios" className="underline underline-offset-2">
              Créalos en Servicios
            </Link>
            .
          </p>
        )}

        <div className="flex items-start justify-between gap-4 rounded-md border bg-subtle px-3 py-2.5">
          <div>
            <Label htmlFor="adflow-exclusive">Modo exclusivo</Label>
            <p className="mt-0.5 text-xs text-text-3">
              El agente no ofrece otros servicios ni precios por su cuenta. Si el cliente pide otro, lo
              redirige en una frase; si insiste, pasa con una persona.
            </p>
          </div>
          <Switch
            checked={exclusive}
            onCheckedChange={setExclusive}
            label="Modo exclusivo"
            disabled={busy}
            className="mt-0.5 shrink-0"
          />
        </div>

        <Field
          label="Reglas para este anuncio"
          htmlFor="adflow-rules"
          error={errors.promptRules}
          hint={`${rules.length}/${AD_FLOW_RULES_MAX} · Opcional. Ej.: «Menciona que la promo vence el domingo».`}
        >
          <Textarea
            id="adflow-rules"
            rows={4}
            maxLength={AD_FLOW_RULES_MAX}
            value={rules}
            onChange={(e) => setRules(e.target.value)}
            disabled={busy}
          />
        </Field>

        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="adflow-active">Flujo encendido</Label>
          <Switch checked={active} onCheckedChange={setActive} label="Flujo encendido" disabled={busy} />
        </div>

        <ModalFooter error={formError}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Guardando…" : flow ? "Guardar cambios" : "Guardar"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
