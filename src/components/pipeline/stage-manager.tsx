"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import type { AutoStageRole, StageDto } from "@/lib/types";
import { AUTO_ROLE_LABEL } from "@/lib/lead-auto-stage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DialogCloseButton } from "@/components/ui/dialog-close";
import { SearchSelect } from "@/components/ui/search-select";

/** Gestión de etapas: renombrar, reordenar, agregar, eliminar (con reasignación). */
export function StageManager({
  stages,
  onClose,
  onChanged,
}: {
  stages: StageDto[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [deleting, setDeleting] = useState<StageDto | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function rename(stage: StageDto, name: string) {
    if (!name.trim() || name === stage.name) return;
    await fetch(`/api/pipeline/stages/${stage.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    }).catch(() => null);
    onChanged();
  }

  /** 044: el papel de la etapa en el avance automático. El servidor rechaza un papel que ya tiene otra etapa. */
  async function setRole(stage: StageDto, role: AutoStageRole | null) {
    setError(null);
    const res = await fetch(`/api/pipeline/stages/${stage.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoRole: role }),
    }).catch(() => null);
    if (res && !res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(data?.error?.message ?? "No se pudo cambiar el papel de la etapa");
    }
    onChanged();
  }

  async function move(stage: StageDto, dir: -1 | 1) {
    const sorted = [...stages].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((s) => s.id === stage.id);
    const swap = sorted[idx + dir];
    if (!swap) return;
    await Promise.all([
      fetch(`/api/pipeline/stages/${stage.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ position: swap.position }),
      }),
      fetch(`/api/pipeline/stages/${swap.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ position: stage.position }),
      }),
    ]).catch(() => null);
    onChanged();
  }

  async function add() {
    if (!newName.trim()) return;
    await fetch("/api/pipeline/stages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
    }).catch(() => null);
    setNewName("");
    onChanged();
  }

  async function remove(stage: StageDto, moveToId: string | null) {
    setError(null);
    const url = moveToId
      ? `/api/pipeline/stages/${stage.id}?moveTo=${moveToId}`
      : `/api/pipeline/stages/${stage.id}`;
    const res = await fetch(url, { method: "DELETE" }).catch(() => null);
    if (!res) return;
    if (res.status === 409) {
      const data = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      if (data?.error?.code === "stage_has_leads") {
        setDeleting(stage);
        return;
      }
      setError(data?.error?.message ?? "No se pudo eliminar");
      return;
    }
    setDeleting(null);
    setMoveTo("");
    onChanged();
  }

  const sorted = [...stages].sort((a, b) => a.position - b.position);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-overlay p-4"
      onClick={onClose}
    >
      <div
        className="relative max-h-[85dvh] w-full max-w-2xl overflow-y-auto rounded-lg border bg-popover p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <DialogCloseButton onClick={onClose} />
        <h3 className="mb-4 pr-8 font-semibold">Etapas del pipeline</h3>
        <ul className="space-y-2">
          {sorted.map((s, i) => (
            <li key={s.id} className="flex items-center gap-2">
              <Input
                defaultValue={s.name}
                onBlur={(e) => void rename(s, e.target.value)}
                className="flex-1"
              />
              {s.kind !== "lost" && (
                <SearchSelect
                  value={s.autoRole ?? ""}
                  onChange={(v) => void setRole(s, (v || null) as AutoStageRole | null)}
                  ariaLabel={`Papel automático de ${s.name}`}
                  placeholder="Sin papel"
                  emptyLabel="Sin papel automático"
                  emptyShowsPlaceholder
                  searchPlaceholder="Buscar papel…"
                  options={(s.kind === "won" ? (["client"] as const) : (["new", "conversation", "interested"] as const)).map((r) => ({
                    value: r,
                    label: AUTO_ROLE_LABEL[r].name,
                    hint: undefined,
                  }))}
                  className="w-44 shrink-0"
                />
              )}
              {s.kind !== "open" ? (
                <Badge variant={s.kind === "won" ? "success" : "secondary"}>
                  {s.kind === "won" ? "ganado" : "perdido"}
                </Badge>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Eliminar etapa"
                  onClick={() => void remove(s, null)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                disabled={i === 0}
                aria-label="Subir"
                onClick={() => void move(s, -1)}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                disabled={i === sorted.length - 1}
                aria-label="Bajar"
                onClick={() => void move(s, 1)}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>

        {(() => {
          const sinAsignar = (Object.keys(AUTO_ROLE_LABEL) as AutoStageRole[]).filter(
            (r) => !stages.some((s) => s.autoRole === r)
          );
          return sinAsignar.length > 0 ? (
            <p className="mt-3 text-xs text-text-3">
              Los leads avanzan solos cuando una etapa tiene papel: a «En conversación» al primer mensaje de
              respuesta, a «Interesado» al agendar una cita y a «Cliente» al registrar una venta.
              Sin papel asignado: {sinAsignar.map((r) => AUTO_ROLE_LABEL[r].name).join(", ")}.
            </p>
          ) : null;
        })()}

        {deleting && (
          <div className="mt-4 rounded-md border border-warning-soft bg-warning-tint p-3">
            <p className="text-sm text-warning-text">
              &quot;{deleting.name}&quot; tiene tarjetas. Elige a dónde moverlas:
            </p>
            <div className="mt-2 flex gap-2">
              <SearchSelect
                value={moveTo}
                onChange={setMoveTo}
                placeholder="Etapa destino…"
                options={sorted
                  .filter((s) => s.id !== deleting.id)
                  .map((s) => ({ value: s.id, label: s.name }))}
                searchPlaceholder="Buscar etapa…"
                className="flex-1"
                triggerClassName="bg-card"
              />
              <Button
                variant="destructive"
                size="sm"
                disabled={!moveTo}
                onClick={() => void remove(deleting, moveTo)}
              >
                Mover y eliminar
              </Button>
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

        <div className="mt-4 flex gap-2 border-t pt-4">
          <Input
            placeholder="Nueva etapa…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
          />
          <Button onClick={() => void add()} disabled={!newName.trim()}>
            Agregar
          </Button>
        </div>

        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </div>
    </div>
  );
}
