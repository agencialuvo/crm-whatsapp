"use client";

import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Buscador estándar del CRM (el mismo de Clientes): lupa a la izquierda, bordes redondeados y un
 * placeholder que dice por qué se puede buscar. Es solo el campo: cada pantalla decide si filtra
 * en el cliente (`matchesQuery`) o pide los datos al servidor.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className,
  maxLength = 80,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Nombre accesible; por defecto, el placeholder. */
  ariaLabel?: string;
  className?: string;
  maxLength?: number;
}) {
  return (
    <div className={cn("relative w-full max-w-sm", className)}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3"
        aria-hidden
      />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        maxLength={maxLength}
        className="pl-9"
      />
    </div>
  );
}
