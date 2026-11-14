"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { apiFetch, describeError } from "@/components/negocio/api";
import { tagColorClass, tagKey, TAG_NAME_MAX, type TagDto, type TagWithCount } from "@/lib/tags";
import { cn } from "@/lib/utils";

/**
 * Etiquetas de un contacto: las que tiene (chips con ✕), un buscador con las del negocio que aún no tiene y,
 * si lo escrito no existe, «Crear …» al vuelo. Asignar y quitar son idempotentes en el servidor, así que dos
 * personas tocando lo mismo no se estorban; el estado que manda es el que devuelve cada respuesta.
 */
export function TagPicker({
  contactId,
  tags,
  onChange,
  disabled,
}: {
  contactId: string;
  tags: TagDto[];
  onChange: (tags: TagDto[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<TagWithCount[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Las del negocio se piden al abrir (y cada vez que se abre: otra persona pudo crear alguna).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    apiFetch<{ tags: TagWithCount[] }>("/api/tags")
      .then((r) => alive && setAll(r.tags))
      .catch((e) => alive && setError(describeError(e)));
    return () => {
      alive = false;
    };
  }, [open]);

  // Escape y clic fuera cierran el selector (sin tocar nada más).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const owned = useMemo(() => new Set(tags.map((t) => t.id)), [tags]);
  const q = tagKey(query);
  const available = useMemo(
    () => (all ?? []).filter((t) => !owned.has(t.id) && (q === "" || tagKey(t.name).includes(q))),
    [all, owned, q]
  );
  const canCreate = query.trim() !== "" && !(all ?? []).some((t) => tagKey(t.name) === q);

  async function assign(body: { tagId: string } | { name: string }) {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<{ tags: TagDto[] }>(`/api/contacts/${contactId}/tags`, { method: "POST", json: body });
      onChange(r.tags);
      setQuery("");
      // La lista del negocio puede haber ganado una etiqueta nueva.
      if ("name" in body) setAll(null);
      setOpen(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(tagId: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<{ tags: TagDto[] }>(`/api/contacts/${contactId}/tags?tagId=${encodeURIComponent(tagId)}`, {
        method: "DELETE",
      });
      onChange(r.tags);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <span
            key={t.id}
            className={cn("inline-flex items-center gap-1 rounded-full border py-0.5 pl-2 pr-1 text-xs font-medium", tagColorClass(t.color))}
          >
            {t.name}
            <button
              type="button"
              aria-label={`Quitar la etiqueta ${t.name}`}
              disabled={disabled || busy}
              onClick={() => void remove(t.id)}
              className="rounded-full p-0.5 hover:bg-black/10 disabled:opacity-50 dark:hover:bg-white/10"
            >
              <X className="h-3 w-3" strokeWidth={2} />
            </button>
          </span>
        ))}
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-xs font-medium text-text-2 hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <Plus className="h-3 w-3" strokeWidth={2} /> Etiqueta
        </button>
      </div>
      {tags.length === 0 && !open && <p className="mt-1.5 text-xs text-text-3">Sin etiquetas.</p>}

      {open && (
        <div className="absolute left-0 right-0 z-20 mt-1.5 rounded-md border bg-popover p-2 shadow-md">
          <Input
            autoFocus
            value={query}
            maxLength={TAG_NAME_MAX}
            placeholder="Buscar o crear etiqueta…"
            aria-label="Buscar o crear etiqueta"
            autoComplete="off"
            disabled={busy}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (available[0]) void assign({ tagId: available[0].id });
              else if (canCreate) void assign({ name: query.trim() });
            }}
          />
          <ul className="mt-1.5 max-h-44 overflow-y-auto" role="listbox" aria-label="Etiquetas del negocio">
            {all === null && !error && <li className="px-2 py-1.5 text-xs text-text-3">Cargando…</li>}
            {available.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void assign({ tagId: t.id })}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", tagColorClass(t.color))}>{t.name}</span>
                </button>
              </li>
            ))}
            {all !== null && available.length === 0 && !canCreate && (
              <li className="px-2 py-1.5 text-xs text-text-3">
                {all.length === 0 ? "Escribe un nombre para crear la primera." : "No hay más etiquetas que agregar."}
              </li>
            )}
            {canCreate && (
              <li>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void assign({ name: query.trim() })}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm font-medium hover:bg-accent"
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={2} /> Crear «{query.trim()}»
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}
