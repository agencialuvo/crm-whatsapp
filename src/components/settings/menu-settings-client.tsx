"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";
import { Switch } from "@/components/ui/switch";
import { apiFetch, describeError } from "@/components/negocio/api";
import { ConfirmDialog, Modal, ModalFooter } from "@/components/negocio/modal";
import { ICON_CATALOG, ICON_KEYS, ICON_LABELS, type IconKey } from "@/lib/icon-catalog";
import {
  MENU_NAME_MAX,
  MENU_SYSTEM_TEMPLATES,
  MENU_TEMPLATE_NAME_MAX,
  configFromResolved,
  findSystemTemplate,
  resolveMenu,
  type MenuConfig,
  type ResolvedGroup,
  type ResolvedItem,
} from "@/lib/menu-config";
import { appNavGroups } from "@/lib/nav";
import { cn } from "@/lib/utils";

type SavedTemplate = { id: string; name: string; config: MenuConfig; updatedAt: string };

const ICON_OPTIONS: SearchSelectOption[] = ICON_KEYS.map((k) => ({ value: k, label: ICON_LABELS[k] }));

/** El texto que se guarda: lo que se escribió, o el de siempre si se dejó vacío. */
function normalized(groups: ResolvedGroup[]): ResolvedGroup[] {
  return groups.map((g) => ({
    ...g,
    title: g.defaultTitle === undefined ? undefined : g.title?.trim() || g.defaultTitle,
    items: g.items.map((r) => ({ ...r, label: r.label.trim() || r.item.label })),
  }));
}

/** Una fila arrastrable: el asa es lo único que arrastra (con el teclado también: Espacio, flechas, Espacio). */
function Sortable({
  id,
  handleLabel,
  disabled = false,
  className,
  children,
}: {
  id: string;
  handleLabel: string;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined,
        transition,
      }}
      className={cn("flex items-start gap-2", isDragging && "relative z-10 opacity-80 shadow-pop", className)}
    >
      {disabled ? (
        <span className="mt-2 w-5 shrink-0" aria-hidden />
      ) : (
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={handleLabel}
          className="mt-2 shrink-0 cursor-grab touch-none rounded-sm p-0.5 text-text-3 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * Ajustes → Menú: arma el menú lateral de la organización. Todo lo que se hace aquí es PRESENTACIÓN: ocultar una
 * entrada la quita de la barra, pero la pantalla, sus datos y su ruta siguen donde estaban (los protegen las banderas,
 * el rol y el plan, no el menú). «Ajustes» no se puede ocultar, y un bloque sin entradas visibles desaparece solo.
 *
 * Las plantillas del sistema son de solo lectura: elegir una carga su contenido en el editor; lo que se cambie después
 * se guarda como el menú de la organización, o como una plantilla NUEVA — nunca sobre la del sistema.
 */
export function MenuSettingsClient({
  agenda,
  salon,
  automations,
  role,
  activeConfig,
  activeBaseKey,
  templates: initialTemplates,
  suggestedKey,
}: {
  agenda: boolean;
  salon: boolean;
  automations: boolean;
  role: string;
  activeConfig: MenuConfig | null;
  activeBaseKey: string | null;
  templates: SavedTemplate[];
  suggestedKey: string;
}) {
  const router = useRouter();
  // El menú base de esta persona: lo que las banderas y el rol dejan ver. La personalización parte de aquí.
  const base = useMemo(() => appNavGroups({ agenda, salon, automations, role }), [agenda, salon, automations, role]);

  const [savedConfig, setSavedConfig] = useState<MenuConfig | null>(activeConfig);
  const [groups, setGroups] = useState<ResolvedGroup[]>(() => resolveMenu(base, activeConfig));
  const [baseKey, setBaseKey] = useState<string | null>(activeBaseKey);
  const [templates, setTemplates] = useState<SavedTemplate[]>(initialTemplates);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [confirm, setConfirm] = useState<"reset" | "delete" | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const currentConfig = useMemo(() => configFromResolved(normalized(groups)), [groups]);
  const savedJson = useMemo(() => JSON.stringify(configFromResolved(resolveMenu(base, savedConfig))), [base, savedConfig]);
  const dirty = JSON.stringify(currentConfig) !== savedJson;

  const savedTemplate = baseKey ? (templates.find((t) => t.id === baseKey) ?? null) : null;
  const baseName = savedTemplate?.name ?? findSystemTemplate(baseKey)?.name ?? null;

  const templateOptions: SearchSelectOption[] = [
    ...MENU_SYSTEM_TEMPLATES.map((t) => ({
      value: `sys:${t.key}`,
      label: t.name,
      group: "Del sistema (solo lectura)",
      ...(t.key === suggestedKey && t.key !== "estandar" ? { hint: "Recomendada" } : {}),
    })),
    ...templates.map((t) => ({ value: `tpl:${t.id}`, label: t.name, group: "Mis plantillas" })),
  ];

  const patchGroup = (key: string, patch: Partial<ResolvedGroup>) =>
    setGroups((gs) => gs.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  const patchItem = (groupKey: string, itemKey: string, patch: Partial<ResolvedItem>) =>
    setGroups((gs) =>
      gs.map((g) =>
        g.key !== groupKey ? g : { ...g, items: g.items.map((r) => (r.item.key === itemKey ? { ...r, ...patch } : r)) }
      )
    );

  function moveItem(fromKey: string, itemKey: string, toKey: string) {
    if (fromKey === toKey) return;
    setGroups((gs) => {
      const moving = gs.find((g) => g.key === fromKey)?.items.find((r) => r.item.key === itemKey);
      if (!moving) return gs;
      return gs.map((g) =>
        g.key === fromKey
          ? { ...g, items: g.items.filter((r) => r.item.key !== itemKey) }
          : g.key === toKey
            ? { ...g, items: [...g.items, moving] }
            : g
      );
    });
  }

  function reorderGroups(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setGroups((gs) => {
      const movable = gs.filter((g) => !g.bottom);
      const from = movable.findIndex((g) => g.key === active.id);
      const to = movable.findIndex((g) => g.key === over.id);
      if (from < 0 || to < 0) return gs;
      return [...arrayMove(movable, from, to), ...gs.filter((g) => g.bottom)];
    });
  }

  function reorderItems(groupKey: string, e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setGroups((gs) =>
      gs.map((g) => {
        if (g.key !== groupKey) return g;
        const from = g.items.findIndex((r) => r.item.key === active.id);
        const to = g.items.findIndex((r) => r.item.key === over.id);
        return from < 0 || to < 0 ? g : { ...g, items: arrayMove(g.items, from, to) };
      })
    );
  }

  function loadTemplate(value: string) {
    setError(null);
    const [kind, ...rest] = value.split(":");
    const key = rest.join(":");
    if (kind === "sys") {
      const t = findSystemTemplate(key);
      if (!t) return;
      setGroups(resolveMenu(base, t.config));
      setBaseKey(t.key);
      setNotice(`Plantilla «${t.name}» cargada. Guarda el menú para aplicarla; la del sistema no se modifica.`);
    } else if (kind === "tpl") {
      const t = templates.find((x) => x.id === key);
      if (!t) return;
      setGroups(resolveMenu(base, t.config));
      setBaseKey(t.id);
      setNotice(`Plantilla «${t.name}» cargada. Guarda el menú para aplicarla.`);
    }
  }

  async function run<T>(fn: () => Promise<T>, done?: (r: T) => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      done?.(await fn());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(
      () => apiFetch("/api/organization/menu", { method: "PUT", json: { config: currentConfig, baseKey } }),
      () => {
        setSavedConfig(currentConfig);
        setNotice("Listo: el menú se actualizó para todo el equipo.");
        router.refresh();
      }
    );

  const reset = () =>
    run(
      () => apiFetch("/api/organization/menu", { method: "DELETE" }),
      () => {
        setSavedConfig(null);
        setGroups(resolveMenu(base, null));
        setBaseKey(null);
        setNotice("Listo: volviste al menú estándar. Tus plantillas guardadas siguen ahí.");
        router.refresh();
      }
    );

  const updateTemplate = () =>
    savedTemplate
      ? run(
          () => apiFetch<{ template: SavedTemplate }>(`/api/organization/menu/templates/${savedTemplate.id}`, { method: "PUT", json: { config: currentConfig } }),
          ({ template }) => {
            setTemplates((ts) => ts.map((t) => (t.id === template.id ? template : t)));
            setNotice(`Plantilla «${template.name}» actualizada.`);
          }
        )
      : Promise.resolve();

  const removeTemplate = () =>
    savedTemplate
      ? run(
          () => apiFetch(`/api/organization/menu/templates/${savedTemplate.id}`, { method: "DELETE" }),
          () => {
            setTemplates((ts) => ts.filter((t) => t.id !== savedTemplate.id));
            setBaseKey(null);
            setNotice("Plantilla eliminada.");
          }
        )
      : Promise.resolve();

  const movable = groups.filter((g) => !g.bottom);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Menú lateral</CardTitle>
        <CardDescription>
          Ordena, oculta, renombra y cambia los iconos del menú de todo el equipo. Ocultar una entrada solo la quita de la barra:
          la pantalla y sus datos siguen donde estaban. «Ajustes» siempre se ve.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <label htmlFor="menu-template" className="text-sm font-medium">
            Partir de una plantilla
          </label>
          <SearchSelect
            id="menu-template"
            value=""
            onChange={loadTemplate}
            options={templateOptions}
            placeholder={baseName ? `Basado en: ${baseName}` : "Elige una plantilla…"}
            searchPlaceholder="Buscar plantilla…"
            disabled={busy}
          />
          <p className="text-xs text-text-3">
            Las plantillas del sistema no se pueden modificar: lo que cambies se guarda como el menú de tu negocio o como una
            plantilla nueva.
          </p>
        </div>

        <DndContext id="menu-grupos" sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorderGroups}>
          <SortableContext items={movable.map((g) => g.key)} strategy={verticalListSortingStrategy}>
            <div className="space-y-4">
              {groups.map((g) => {
                const visible = g.items.filter((r) => !r.hidden && (!g.hidden || r.protected)).length;
                return (
                  <Sortable key={g.key} id={g.key} disabled={g.bottom} handleLabel={`Mover el bloque ${g.title ?? g.items[0]?.label ?? ""}`} className="rounded-md border bg-subtle/40 p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      {g.defaultTitle !== undefined ? (
                        <Input
                          aria-label={`Nombre del bloque ${g.defaultTitle}`}
                          value={g.title ?? ""}
                          maxLength={MENU_NAME_MAX}
                          disabled={busy}
                          onChange={(e) => patchGroup(g.key, { title: e.target.value })}
                          onBlur={() => patchGroup(g.key, { title: g.title?.trim() || g.defaultTitle })}
                          className="h-8 w-48 font-semibold"
                        />
                      ) : (
                        <span className="text-sm font-semibold text-text-2">Entrada suelta</span>
                      )}
                      <div className="ml-auto flex items-center gap-2 text-xs text-text-3">
                        {visible === 0 && <span>Sin entradas visibles: no se muestra</span>}
                        <Switch
                          size="sm"
                          checked={!g.hidden}
                          onCheckedChange={(on) => patchGroup(g.key, { hidden: !on })}
                          label={`Mostrar el bloque ${g.title ?? ""}`}
                          disabled={busy || g.bottom}
                        />
                      </div>
                    </div>
                    <DndContext id={`menu-items-${g.key}`} sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => reorderItems(g.key, e)}>
                      <SortableContext items={g.items.map((r) => r.item.key)} strategy={verticalListSortingStrategy}>
                        <ul className="space-y-2">
                          {g.items.map((r) => {
                            const Icon = ICON_CATALOG[r.iconKey];
                            const effectivelyHidden = r.hidden || (g.hidden && !r.protected);
                            return (
                              <li key={r.item.key}>
                                <Sortable id={r.item.key} handleLabel={`Mover ${r.label}`} className="rounded-md border bg-background p-2">
                                  <div className={cn("flex flex-wrap items-center gap-2", effectivelyHidden && "opacity-60")}>
                                    <Icon className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
                                    <Input
                                      aria-label={`Nombre de ${r.item.label}`}
                                      value={r.label}
                                      maxLength={MENU_NAME_MAX}
                                      disabled={busy}
                                      onChange={(e) => patchItem(g.key, r.item.key, { label: e.target.value })}
                                      onBlur={() => patchItem(g.key, r.item.key, { label: r.label.trim() || r.item.label })}
                                      className="h-8 w-44"
                                    />
                                    <div className="w-40">
                                      <SearchSelect
                                        ariaLabel={`Icono de ${r.label}`}
                                        value={r.iconKey}
                                        onChange={(v) => patchItem(g.key, r.item.key, { iconKey: v as IconKey })}
                                        options={ICON_OPTIONS}
                                        placeholder="Icono…"
                                        searchPlaceholder="Buscar icono…"
                                        disabled={busy}
                                      />
                                    </div>
                                    {!g.bottom && movable.length > 1 && (
                                      <div className="w-40">
                                        <SearchSelect
                                          ariaLabel={`Mover ${r.label} a otro bloque`}
                                          value=""
                                          onChange={(to) => moveItem(g.key, r.item.key, to)}
                                          options={movable
                                            .filter((x) => x.key !== g.key)
                                            .map((x) => ({ value: x.key, label: x.title ?? "Entrada suelta" }))}
                                          placeholder="Mover a…"
                                          searchPlaceholder="Buscar bloque…"
                                          disabled={busy}
                                        />
                                      </div>
                                    )}
                                    <div className="ml-auto flex items-center gap-2">
                                      {r.protected && <span className="text-xs text-text-3">Siempre visible</span>}
                                      <Switch
                                        size="sm"
                                        checked={!r.hidden}
                                        onCheckedChange={(on) => patchItem(g.key, r.item.key, { hidden: !on })}
                                        label={`Mostrar ${r.label} en el menú`}
                                        disabled={busy || r.protected}
                                      />
                                    </div>
                                  </div>
                                </Sortable>
                              </li>
                            );
                          })}
                        </ul>
                      </SortableContext>
                    </DndContext>
                  </Sortable>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>

        {error && (
          <p role="alert" className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded-md border border-success-soft bg-success-tint px-3 py-2 text-sm text-success-text">
            {notice}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? "Guardando…" : "Guardar menú"}
          </Button>
          <Button type="button" variant="outline" onClick={() => setNaming(true)} disabled={busy}>
            Guardar como plantilla nueva
          </Button>
          {savedTemplate && (
            <>
              <Button type="button" variant="outline" onClick={() => void updateTemplate()} disabled={busy}>
                Actualizar «{savedTemplate.name}»
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirm("delete")} disabled={busy}>
                Eliminar «{savedTemplate.name}»
              </Button>
            </>
          )}
          <Button type="button" variant="ghost" className="ml-auto" onClick={() => setConfirm("reset")} disabled={busy}>
            Volver al menú estándar
          </Button>
        </div>
      </CardContent>

      {naming && (
        <NameTemplateDialog
          onClose={() => setNaming(false)}
          onSave={async (name) => {
            const { template } = await apiFetch<{ template: SavedTemplate }>("/api/organization/menu/templates", {
              method: "POST",
              json: { name, config: currentConfig },
            });
            setTemplates((ts) => [...ts, template].sort((a, b) => a.name.localeCompare(b.name)));
            setBaseKey(template.id);
            setNotice(`Plantilla «${template.name}» guardada. Para aplicarla a tu menú, pulsa «Guardar menú».`);
          }}
        />
      )}
      {confirm === "reset" && (
        <ConfirmDialog
          title="Volver al menú estándar"
          message="El menú de todo el equipo vuelve al orden, los nombres y los iconos de siempre. Tus plantillas guardadas no se borran."
          confirmLabel="Volver al estándar"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            setConfirm(null);
            await reset();
          }}
        />
      )}
      {confirm === "delete" && savedTemplate && (
        <ConfirmDialog
          title="Eliminar plantilla"
          message={`¿Eliminar la plantilla «${savedTemplate.name}»? El menú que ya está aplicado no cambia.`}
          confirmLabel="Eliminar"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            setConfirm(null);
            await removeTemplate();
          }}
        />
      )}
    </Card>
  );
}

/** Pide el nombre de la plantilla nueva; el error del servidor (nombre repetido…) se ve sin perder lo escrito. */
function NameTemplateDialog({ onClose, onSave }: { onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Escribe un nombre para la plantilla");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(name.trim());
      onClose();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Guardar como plantilla nueva" description="Se guarda una copia del menú que armaste, aparte de las plantillas del sistema." onClose={onClose} busy={busy} size="sm">
      <form onSubmit={submit} noValidate className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="menu-template-name" className="text-sm font-medium">
            Nombre
          </label>
          <Input
            id="menu-template-name"
            value={name}
            maxLength={MENU_TEMPLATE_NAME_MAX}
            placeholder="Mi menú de consultoría"
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </div>
        <ModalFooter error={error}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Guardando…" : "Guardar plantilla"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
