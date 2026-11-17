"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { CHANNEL_LABEL, type Channel } from "@/lib/channels";
import type { BoardFiltersDto, PriorityValue } from "@/lib/types";
import { SearchSelect } from "@/components/ui/search-select";

/**
 * 044 — Barra de filtros del tablero. La búsqueda es la de la Bandeja (nombre, teléfono o texto de un
 * mensaje) y es un input NO controlado: el padre aplica el debounce y la lista se actualiza sin que el
 * operador pierda el foco ni lo que lleva escrito.
 */
export function PipelineFilters({
  filters,
  channels,
  onChange,
}: {
  filters: BoardFiltersDto;
  channels: readonly Channel[];
  onChange: (patch: Partial<BoardFiltersDto>) => void;
}) {
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    let vivo = true;
    void fetch("/api/tags")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { tags?: { id: string; name: string }[] } | null) => {
        if (vivo && d?.tags) setTags(d.tags);
      })
      .catch(() => null);
    return () => {
      vivo = false;
    };
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 sm:px-6" data-testid="pipeline-filters">
      <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-full border border-border-strong bg-chip px-3.5 py-[6px] shadow-sm focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand-soft sm:max-w-sm">
        <Search className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.7} />
        <input
          placeholder="Buscar nombre, teléfono o mensaje…"
          aria-label="Buscar en el tablero"
          defaultValue=""
          onChange={(e) => onChange({ q: e.target.value })}
          className="w-full bg-transparent text-[13px] outline-none placeholder:text-text-3"
        />
      </div>

      <SearchSelect
        value={filters.priority ?? ""}
        onChange={(v) => onChange({ priority: (v || undefined) as PriorityValue | "sin" | undefined })}
        ariaLabel="Filtrar por prioridad"
        placeholder="Toda prioridad"
        emptyLabel="Toda prioridad"
        emptyShowsPlaceholder
        searchPlaceholder="Buscar prioridad…"
        options={[
          { value: "alta", label: "Alta" },
          { value: "media", label: "Media" },
          { value: "baja", label: "Baja" },
          { value: "sin", label: "Sin prioridad" },
        ]}
        className="w-40"
      />

      {tags.length > 0 && (
        <SearchSelect
          value={filters.tag ?? ""}
          onChange={(v) => onChange({ tag: v || undefined })}
          ariaLabel="Filtrar por etiqueta"
          placeholder="Toda etiqueta"
          emptyLabel="Toda etiqueta"
          emptyShowsPlaceholder
          searchPlaceholder="Buscar etiqueta…"
          options={tags.map((t) => ({ value: t.id, label: t.name }))}
          className="w-44"
        />
      )}

      {channels.length > 1 && (
        <SearchSelect
          value={filters.channel ?? ""}
          onChange={(v) => onChange({ channel: (v || undefined) as Channel | undefined })}
          ariaLabel="Filtrar por canal"
          placeholder="Todo canal"
          emptyLabel="Todo canal"
          emptyShowsPlaceholder
          searchPlaceholder="Buscar canal…"
          options={channels.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))}
          className="w-40"
        />
      )}
    </div>
  );
}
