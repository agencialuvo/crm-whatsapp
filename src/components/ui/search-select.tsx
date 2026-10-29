"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export type SearchSelectOption = {
  value: string;
  label: string;
  /** Encabezado de grupo (las opciones del mismo grupo deben ir juntas). */
  group?: string;
  /** Texto secundario a la derecha (p. ej. un precio). */
  hint?: string;
};

/** Minúsculas y sin tildes: «jose» encuentra «José». */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

type Placement = { top?: number; bottom?: number; left: number; width: number };

/**
 * REGLA DEL SISTEMA: todo desplegable lleva buscador. Este componente es el
 * único desplegable permitido (no uses `<select>`).
 *
 * El buscador está DENTRO del desplegable; se navega con ↑ ↓, se elige con
 * Enter y se cierra con Escape (sin cerrar la ventana que lo contiene), con
 * Tab o tocando fuera. La lista se pinta en el `body` con posición fija: no la
 * recorta ninguna ventana ni contenedor con scroll, y se abre hacia arriba si
 * abajo no cabe.
 */
export function SearchSelect({
  id,
  value,
  onChange,
  options,
  placeholder = "Elige…",
  searchPlaceholder = "Buscar…",
  emptyLabel,
  emptyShowsPlaceholder = false,
  ariaLabel,
  disabled,
  invalid,
  className,
  triggerClassName,
  minListWidth = 0,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SearchSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  /** Si se da, añade al inicio la opción «sin elegir» (valor `""`) con este texto. */
  emptyLabel?: string;
  /** Sin nada elegido, el botón muestra el `placeholder` (la opción vacía solo sirve para limpiar). */
  emptyShowsPlaceholder?: boolean;
  /** Nombre accesible cuando no hay `<label>` visible. */
  ariaLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  /** Para cambiar el aspecto del botón (p. ej. una píldora de filtro). */
  triggerClassName?: string;
  /** Ancho mínimo (px) de la lista cuando el botón es angosto. */
  minListWidth?: number;
}) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<Placement | null>(null);

  const all = useMemo<SearchSelectOption[]>(
    () => (emptyLabel ? [{ value: "", label: emptyLabel }, ...options] : options),
    [options, emptyLabel]
  );
  const visible = useMemo(() => {
    const q = fold(query.trim());
    return q ? all.filter((o) => fold(o.label).includes(q)) : all;
  }, [all, query]);
  const selected = all.find((o) => o.value === value);

  // Posición de la lista junto al botón (se recalcula al desplazarse o redimensionar).
  useLayoutEffect(() => {
    if (!open) return;
    function measure() {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.max(r.width, minListWidth);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      const below = window.innerHeight - r.bottom;
      // La lista mide ~300 px con su buscador: si abajo no cabe y arriba sí, se abre arriba.
      if (below < 300 && r.top > below) {
        setPlace({ bottom: window.innerHeight - r.top + 4, left, width });
      } else {
        setPlace({ top: r.bottom + 4, left, width });
      }
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, minListWidth]);

  // Tocar fuera cierra el desplegable.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popoverRef.current?.contains(t)) return;
      setOpen(false);
      setQuery("");
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // El buscador toma el foco al abrir; la opción activa arranca en la elegida.
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const i = visible.findIndex((o) => o.value === value);
    setActive(i >= 0 ? i : 0);
    // Solo al abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // La primera vez, el panel se monta un instante DESPUÉS de abrir (hasta medir el botón no
  // tiene posición): el foco del efecto de arriba no lo encuentra. Aquí se le da al montarse.
  const placed = place !== null;
  useEffect(() => {
    if (open && placed) searchRef.current?.focus();
  }, [open, placed]);

  // La opción activa siempre a la vista.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, listId]);

  function close(refocus = false) {
    setOpen(false);
    setQuery("");
    if (refocus) triggerRef.current?.focus();
  }

  function choose(o: SearchSelectOption) {
    onChange(o.value);
    close(true);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      // Cierra solo el desplegable, no la ventana que lo contiene.
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(visible.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = visible[active];
      if (o) choose(o);
    } else if (e.key === "Tab") {
      close();
    }
  }

  return (
    <div className={cn("relative", className)}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-left text-sm shadow-sm",
          "focus-visible:border-brand focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft",
          "disabled:cursor-not-allowed disabled:opacity-50",
          invalid ? "border-danger" : "border-input",
          triggerClassName
        )}
      >
        <span className={cn("truncate", !selected || selected.value === "" ? "text-text-3" : "")}>
          {selected && selected.value !== ""
            ? selected.label
            : emptyShowsPlaceholder
              ? placeholder
              : (selected?.label ?? placeholder)}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
      </button>

      {open &&
        place &&
        createPortal(
          <div
            ref={popoverRef}
            style={{
              position: "fixed",
              top: place.top,
              bottom: place.bottom,
              left: place.left,
              width: place.width,
            }}
            // Por encima de las ventanas emergentes (z-50).
            className="z-[70] overflow-hidden rounded-md border bg-popover shadow-pop"
            onKeyDown={onKeyDown}
          >
            <div className="relative border-b">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3"
                aria-hidden
              />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                aria-controls={listId}
                autoComplete="off"
                className="h-9 w-full bg-transparent pl-9 pr-3 text-sm text-foreground focus:outline-none"
              />
            </div>
            <ul id={listId} role="listbox" className="max-h-56 overflow-y-auto py-1">
              {visible.length === 0 ? (
                <li className="px-3 py-2 text-sm text-text-3">Sin resultados</li>
              ) : (
                visible.map((o, i) => (
                  <li key={o.value || "__empty"} role="presentation">
                    {o.group && o.group !== visible[i - 1]?.group && (
                      <p className="px-3 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-3">
                        {o.group}
                      </p>
                    )}
                    <div
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={o.value === value}
                      onMouseEnter={() => setActive(i)}
                      // mousedown (no click): el buscador no pierde el foco antes de elegir.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(o);
                      }}
                      className={cn(
                        "flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-sm text-foreground",
                        i === active && "bg-accent"
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Check
                          className={cn(
                            "h-3.5 w-3.5 shrink-0",
                            o.value === value ? "opacity-100" : "opacity-0"
                          )}
                          aria-hidden
                        />
                        <span className="truncate">{o.label}</span>
                      </span>
                      {o.hint && <span className="shrink-0 text-xs text-text-3">{o.hint}</span>}
                    </div>
                  </li>
                ))
              )}
            </ul>
          </div>,
          document.body
        )}
    </div>
  );
}
