"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type ComboboxOption = {
  value: string;
  /** Texto secundario a la derecha (p. ej. un dato de apoyo). */
  hint?: string;
};

/** Minúsculas y sin tildes: «jose» encuentra «José». */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

type Placement = { top?: number; bottom?: number; left: number; width: number };

/**
 * Campo de texto con lista de sugerencias que filtra mientras escribes: el propio
 * campo es el buscador. A diferencia de `SearchSelect` (que obliga a elegir una
 * opción), aquí se puede elegir una existente O escribir un valor nuevo.
 *
 * ↑ ↓ recorren la lista, Enter elige la resaltada (si no hay ninguna resaltada,
 * Enter envía el formulario como siempre), Escape cierra solo la lista, Tab o
 * tocar fuera también. La lista se pinta en el `body` con posición fija: ninguna
 * ventana ni contenedor con scroll la recorta, y se abre hacia arriba si abajo no cabe.
 */
export function ComboboxInput({
  id,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  invalid,
  maxLength,
  newHint = "Nombre nuevo: se usará tal cual.",
  className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  maxLength?: number;
  /** Lo que dice la lista cuando lo escrito no coincide con ninguna opción. */
  newHint?: string;
  className?: string;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Hasta que la persona teclea, la lista muestra TODAS las opciones (aunque el campo ya tenga un valor).
  const [typed, setTyped] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<Placement | null>(null);

  const visible = useMemo(() => {
    const q = fold(value.trim());
    return typed && q ? options.filter((o) => fold(o.value).includes(q)) : options;
  }, [options, value, typed]);
  const exact = options.some((o) => fold(o.value) === fold(value.trim()));
  const showList = open && (visible.length > 0 || value.trim() !== "");

  useLayoutEffect(() => {
    if (!showList) return;
    function measure() {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8));
      const below = window.innerHeight - r.bottom;
      if (below < 260 && r.top > below) {
        setPlace({ bottom: window.innerHeight - r.top + 4, left, width: r.width });
      } else {
        setPlace({ top: r.bottom + 4, left, width: r.width });
      }
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [showList]);

  // Tocar fuera cierra la lista.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (inputRef.current?.contains(t) || popoverRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // La opción resaltada siempre a la vista.
  useEffect(() => {
    if (active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  function choose(o: ComboboxOption) {
    onChange(o.value);
    setOpen(false);
    setTyped(false);
    setActive(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((i) => Math.min(i + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      const o = open ? visible[active] : undefined;
      if (o) {
        e.preventDefault();
        choose(o);
      }
    } else if (e.key === "Escape" && open) {
      // Cierra solo la lista, no la ventana que contiene el campo. La ventana escucha
      // el teclado en `document` (donde React también escucha), así que no basta con
      // `stopPropagation`: hay que cortar también a los demás oyentes de ese nodo.
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div className={cn("relative", className)}>
      <Input
        ref={inputRef}
        id={id}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        aria-invalid={invalid || undefined}
        maxLength={maxLength}
        autoComplete="off"
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          setTyped(true);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => {
          setTyped(false);
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {showList &&
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
          >
            <ul id={listId} role="listbox" className="max-h-56 overflow-y-auto py-1">
              {visible.map((o, i) => (
                <li
                  key={o.value}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={fold(o.value) === fold(value.trim())}
                  onMouseEnter={() => setActive(i)}
                  // mousedown (no click): el campo no pierde el foco antes de elegir.
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
                        fold(o.value) === fold(value.trim()) ? "opacity-100" : "opacity-0"
                      )}
                      aria-hidden
                    />
                    <span className="truncate">{o.value}</span>
                  </span>
                  {o.hint && <span className="shrink-0 text-xs text-text-3">{o.hint}</span>}
                </li>
              ))}
              {!exact && value.trim() !== "" && (
                <li
                  role="presentation"
                  className={cn("px-3 py-1.5 text-xs text-text-3", visible.length > 0 && "border-t")}
                >
                  {newHint}
                </li>
              )}
            </ul>
          </div>,
          document.body
        )}
    </div>
  );
}
