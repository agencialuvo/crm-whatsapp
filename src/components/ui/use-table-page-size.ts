"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/components/negocio/api";
import { isPageSize } from "@/lib/pagination";

type Sizes = Record<string, number>;

/** Se pide una sola vez por pestaña: Caja y Clientes comparten la respuesta. */
let loaded: Promise<Sizes> | null = null;

function loadSizes(): Promise<Sizes> {
  loaded ??= apiFetch<{ tablePageSizes: Sizes }>("/api/account/ui-preferences")
    .then((r) => r.tablePageSizes)
    .catch(() => {
      // Sin red o sin sesión: se usa el valor por defecto y se reintenta en la próxima pantalla.
      loaded = null;
      return {} as Sizes;
    });
  return loaded;
}


/**
 * Filas por página de una tabla, recordadas por persona. Arranca con `fallback` (la pantalla
 * se ve igual que siempre), toma lo guardado en cuanto llega y guarda cada cambio sin
 * bloquear: si guardar falla, el cambio vale en pantalla y simplemente no se recuerda.
 */
export function useTablePageSize(view: string, fallback: number): [number, (size: number) => void] {
  const [size, setSize] = useState(fallback);

  useEffect(() => {
    let alive = true;
    void loadSizes().then((sizes) => {
      const saved = sizes[view];
      if (alive && isPageSize(saved)) setSize(saved);
    });
    return () => {
      alive = false;
    };
  }, [view]);

  const change = useCallback(
    (next: number) => {
      if (!isPageSize(next)) return;
      setSize(next);
      void loadSizes().then((sizes) => {
        sizes[view] = next;
      });
      void apiFetch("/api/account/ui-preferences", { method: "PUT", json: { view, pageSize: next } }).catch(() => undefined);
    },
    [view]
  );

  return [size, change];
}
