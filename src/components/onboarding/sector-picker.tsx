"use client";

import { Briefcase, HeartPulse, Scissors, Store, UserRound, type LucideIcon } from "lucide-react";
import type { BusinessSector } from "@/lib/business-sector";
import { cn } from "@/lib/utils";

/** Un icono por sector conocido; un sector nuevo del catálogo usa el genérico y no hace falta tocar esto. */
const SECTOR_ICON: Record<string, LucideIcon> = {
  salon: Scissors,
  health: HeartPulse,
  personal_brand: UserRound,
  services: Briefcase,
};

/**
 * «¿Qué tipo de negocio tienes?» — tarjetas de opción única (radio nativo, así que el teclado y los
 * lectores de pantalla funcionan solos: flechas para moverse, Espacio para elegir). Una columna en
 * móvil; el texto largo se acomoda sin recortar.
 */
export function SectorPicker({
  sectors,
  value,
  onChange,
  error,
  disabled = false,
}: {
  sectors: BusinessSector[];
  value: string;
  onChange: (key: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <fieldset className="space-y-1.5" disabled={disabled} aria-describedby={error ? "sector-error" : undefined}>
      <legend className="mb-1.5 text-sm font-medium text-foreground">
        ¿Qué tipo de negocio tienes? <span className="ml-0.5 font-semibold text-danger-text" aria-hidden>*</span>
      </legend>
      <div className="grid gap-2">
        {sectors.map((s) => {
          const Icon = SECTOR_ICON[s.key] ?? Store;
          const selected = value === s.key;
          return (
            <label
              key={s.key}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors",
                "focus-within:ring-[3px] focus-within:ring-brand-soft",
                selected ? "border-brand bg-brand-tint" : "border-border-strong hover:border-brand hover:bg-accent",
                error && !selected && "border-destructive",
                disabled && "cursor-not-allowed opacity-60"
              )}
            >
              <input
                type="radio"
                name="categoryKey"
                value={s.key}
                checked={selected}
                onChange={() => onChange(s.key)}
                className="sr-only"
              />
              <span
                className={cn(
                  "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                  selected ? "bg-brand text-brand-fg" : "bg-subtle text-text-3"
                )}
              >
                <Icon className="h-4 w-4" strokeWidth={1.8} aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-sm font-semibold", selected && "text-brand-text")}>{s.name}</span>
                {s.description && <span className="block text-xs leading-snug text-text-3">{s.description}</span>}
              </span>
            </label>
          );
        })}
      </div>
      {error && (
        <p id="sector-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
