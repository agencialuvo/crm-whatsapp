"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { PALETTE, PALETTE_CATEGORY_HINTS, PALETTE_CATEGORY_LABELS, PALETTE_DRAG_TYPE, paletteMatches, type PaletteCategory, type PaletteItem } from "@/lib/automation-canvas";
import { cn } from "@/lib/utils";
import { ICONS, TONE_STYLES } from "./node-icons";

const CATEGORIES: PaletteCategory[] = ["triggers", "decide", "wait", "actions"];

/** Agrupa (en orden) los bloques de una categoría por su subgrupo. */
function byGroup(items: PaletteItem[]): { group: string; items: PaletteItem[] }[] {
  const out: { group: string; items: PaletteItem[] }[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last && last.group === item.group) last.items.push(item);
    else out.push({ group: item.group, items: [item] });
  }
  return out;
}

/**
 * La paleta de bloques: categorías con subgrupos y un buscador. Se arrastran al lienzo (o se tocan para añadirlos en
 * el centro, que también sirve con teclado y en el móvil). Un disparador REEMPLAZA el del flujo (hay exactamente
 * uno); lo que aún no existe en el motor aparece como «Próximamente» y no se puede soltar.
 */
export function NodePalette({
  triggerType,
  onAdd,
  disabled,
  codeJsEnabled = false,
}: {
  /** El disparador actual del lienzo: decide qué bloques de cita tienen sentido. */
  triggerType: string;
  onAdd: (item: PaletteItem) => void;
  disabled?: boolean;
  /** El bloque de código solo se puede usar si la instancia lo enciende. */
  codeJsEnabled?: boolean;
}) {
  const isBooking = triggerType.startsWith("booking_");
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";

  const visible = useMemo(() => PALETTE.filter((i) => paletteMatches(i, query)), [query]);

  return (
    <aside
      aria-label="Bloques"
      className="flex max-h-48 shrink-0 flex-col gap-3 overflow-y-auto overscroll-contain border-b border-border-strong bg-card p-3 lg:max-h-none lg:w-60 lg:border-b-0 lg:border-r"
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar bloque…"
          aria-label="Buscar bloque"
          className="h-8 w-full rounded-md border border-border-strong bg-background pl-7 pr-2 text-[13px] placeholder:text-text-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <p className="text-[11px] text-text-3">Arrastra un bloque al lienzo, o tócalo para añadirlo.</p>

      {searching && visible.length === 0 && (
        <p role="status" className="rounded-md border border-dashed border-border-strong px-2 py-3 text-center text-xs text-text-3">
          Ningún bloque coincide con «{query.trim()}».
        </p>
      )}

      {CATEGORIES.map((cat) => {
        const items = visible.filter((i) => i.category === cat);
        if (items.length === 0) return null;
        return (
          <section key={cat} aria-label={PALETTE_CATEGORY_LABELS[cat]}>
            <h4 className="kicker text-text-3">{PALETTE_CATEGORY_LABELS[cat]}</h4>
            <p className="mb-1.5 text-[10px] text-text-4">{PALETTE_CATEGORY_HINTS[cat]}</p>
            <div className="space-y-2">
              {byGroup(items).map(({ group, items: groupItems }) => (
                <div key={group}>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-4">{group}</p>
                  <ul className="flex flex-wrap gap-1.5 lg:flex-col lg:flex-nowrap">
                    {groupItems.map((item) => {
                      const bookingBlocked = !!item.needsBooking && !isBooking;
                      const noCode = item.stepType === "code_js" && !codeJsEnabled;
                      const off = disabled || !!item.soon || bookingBlocked || noCode;
                      const current = item.kind === "trigger" && item.triggerType === triggerType;
                      const note = item.soon ? "Próximamente" : noCode ? "No activado en esta instancia" : bookingBlocked ? "Solo en flujos de cita" : current ? "Disparador actual" : item.hint;
                      const Icon = ICONS[item.icon];
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            draggable={!off}
                            disabled={off}
                            title={note}
                            onClick={() => onAdd(item)}
                            onDragStart={(e) => {
                              e.dataTransfer.setData(PALETTE_DRAG_TYPE, item.id);
                              e.dataTransfer.effectAllowed = "move";
                            }}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              off
                                ? "cursor-not-allowed border-border bg-subtle text-text-4"
                                : "cursor-grab border-border-strong bg-background hover:border-brand hover:bg-brand-tint active:cursor-grabbing",
                              current && "border-brand bg-brand-tint text-brand-text"
                            )}
                          >
                            <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded", off ? "bg-subtle text-text-4" : TONE_STYLES[item.tone].chip)}>
                              <Icon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
                            </span>
                            <span className="min-w-0 flex-1">
                              {item.label}
                              {(item.soon || bookingBlocked || noCode || current) && <span className="block text-[10px] font-normal text-text-3">{note}</span>}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </aside>
  );
}
