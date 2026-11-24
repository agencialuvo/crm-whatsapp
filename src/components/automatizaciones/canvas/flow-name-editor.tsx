"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { cleanFlowName } from "@/lib/automation-dto";
import { cn } from "@/lib/utils";

/**
 * El nombre del flujo en la cabecera del lienzo: se pulsa y se edita ahí mismo. Enter o salir del campo lo guarda;
 * Escape lo descarta. Si el nombre es el mismo, o queda vacío, no se llama al servidor. Un fallo se dice junto al
 * campo y el texto escrito se conserva para corregirlo.
 */
export function FlowNameEditor({ name, onRename }: { name: string; onRename: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Enter y el blur que le sigue al desmontar el campo no deben guardar dos veces.
  const finishing = useRef(false);

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  function start() {
    finishing.current = false;
    setDraft(name);
    setError(null);
    setEditing(true);
  }

  async function commit() {
    if (finishing.current) return;
    const next = cleanFlowName(draft);
    if (next === null) {
      setError("Escribe un nombre (hasta 120 caracteres)");
      return;
    }
    if (next === name) {
      finishing.current = true;
      setEditing(false);
      return;
    }
    finishing.current = true;
    setBusy(true);
    setError(null);
    try {
      await onRename(next);
      setEditing(false);
    } catch (err) {
      finishing.current = false;
      setError(err instanceof Error ? err.message : "No se pudo renombrar");
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    finishing.current = true;
    setError(null);
    setEditing(false);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={start}
        title="Cambiar el nombre del flujo"
        aria-label={`Nombre del flujo: ${name}. Pulsa para cambiarlo`}
        className="group inline-flex max-w-[240px] items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="truncate text-sm font-bold tracking-tight">{name}</span>
        <Pencil className="h-3 w-3 shrink-0 text-text-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
      </button>
    );
  }

  return (
    <div className="relative">
      <input
        ref={input}
        value={draft}
        maxLength={120}
        disabled={busy}
        aria-label="Nombre del flujo"
        aria-invalid={!!error}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => void commit()}
        className={cn(
          "h-8 w-[220px] rounded-md border bg-background px-2 text-sm font-bold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
          error ? "border-danger-text" : "border-input"
        )}
      />
      {error && (
        <p role="alert" className="absolute left-0 top-full z-20 mt-1 w-max max-w-[280px] rounded-md border border-danger-soft bg-danger-tint px-2 py-1 text-xs text-danger-text shadow-md">
          {error}
        </p>
      )}
    </div>
  );
}
