"use client";

import { PALETTE, PALETTE_CATEGORY_LABELS, PALETTE_DRAG_TYPE, type PaletteCategory, type PaletteItem } from "@/lib/automation-canvas";
import { cn } from "@/lib/utils";

const CATEGORIES: PaletteCategory[] = ["triggers", "logic", "actions"];

/**
 * La paleta de bloques: se arrastran al lienzo (o se tocan para añadirlos en el centro, que también sirve con
 * teclado y en el móvil). Un disparador REEMPLAZA el del flujo (hay exactamente uno); lo que aún no existe en el
 * motor aparece como «Próximamente» y no se puede soltar.
 */
export function NodePalette({
  triggerType,
  onAdd,
  disabled,
}: {
  /** El disparador actual del lienzo: decide qué bloques de cita tienen sentido. */
  triggerType: string;
  onAdd: (item: PaletteItem) => void;
  disabled?: boolean;
}) {
  const isBooking = triggerType.startsWith("booking_");

  return (
    <aside
      aria-label="Bloques"
      className="flex max-h-40 shrink-0 flex-col gap-3 overflow-y-auto overscroll-contain border-b border-border-strong bg-card p-3 lg:max-h-none lg:w-56 lg:border-b-0 lg:border-r"
    >
      <p className="text-[11px] text-text-3">Arrastra un bloque al lienzo, o tócalo para añadirlo.</p>
      {CATEGORIES.map((cat) => (
        <section key={cat} aria-label={PALETTE_CATEGORY_LABELS[cat]}>
          <h4 className="kicker mb-1.5 text-text-3">{PALETTE_CATEGORY_LABELS[cat]}</h4>
          <ul className="flex flex-wrap gap-1.5 lg:flex-col lg:flex-nowrap">
            {PALETTE.filter((i) => i.category === cat).map((item) => {
              const bookingBlocked = !!item.needsBooking && !isBooking;
              const off = disabled || !!item.soon || bookingBlocked;
              const current = item.kind === "trigger" && item.triggerType === triggerType;
              const note = item.soon ? "Próximamente" : bookingBlocked ? "Solo en flujos de cita" : current ? "Disparador actual" : item.hint;
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
                      "w-full rounded-md border px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      off
                        ? "cursor-not-allowed border-border bg-subtle text-text-4"
                        : "cursor-grab border-border-strong bg-background hover:border-brand hover:bg-brand-tint active:cursor-grabbing",
                      current && "border-brand bg-brand-tint text-brand-text"
                    )}
                  >
                    {item.label}
                    {(item.soon || bookingBlocked || current) && <span className="block text-[10px] font-normal text-text-3">{note}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}
