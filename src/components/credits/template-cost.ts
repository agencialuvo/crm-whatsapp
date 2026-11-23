"use client";

import { useEffect, useState } from "react";
import { formatCoinsLabel, templateRateKey } from "@/lib/credits";

/**
 * Monedas — el costo de una plantilla de WhatsApp, dicho antes de enviarla. Lo que cuesta cada categoría viene de
 * `/api/credits/summary` (la tarifa vigente); con las monedas apagadas el servidor responde `enabled: false` y no se
 * muestra nada. Un fallo al pedirlo tampoco muestra nada: el envío no depende de esto.
 */

export type TemplateCosts = { enabled: boolean; costs: Record<string, number> } | null;

/** Pide los costos una vez por pantalla. `null` mientras carga o si no aplica. */
export function useTemplateCosts(): TemplateCosts {
  const [costs, setCosts] = useState<TemplateCosts>(null);
  useEffect(() => {
    let vivo = true;
    void fetch("/api/credits/summary")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { enabled?: boolean; templateCosts?: Record<string, number> } | null) => {
        if (vivo && d?.enabled && d.templateCosts) setCosts({ enabled: true, costs: d.templateCosts });
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, []);
  return costs;
}

/** Cuánto cuesta una plantilla de esa categoría (unidades), o 0 si no cuesta o no se sabe. */
export function templateCostUnits(costs: TemplateCosts, category: string | null | undefined): number {
  if (!costs?.enabled) return 0;
  const key = templateRateKey(category).replace("wa.template.", "");
  return costs.costs[key] ?? 0;
}

/** «3 monedas», o `null` si no hay nada que decir (monedas apagadas o plantilla sin costo). */
export function templateCostLabel(costs: TemplateCosts, category: string | null | undefined): string | null {
  const units = templateCostUnits(costs, category);
  return units > 0 ? formatCoinsLabel(units) : null;
}

/**
 * Lo que se le dice a la persona cuando el envío de una plantilla falla: si fue 402 `no_credit` (sin monedas con el
 * corte activo), el mensaje claro con el costo; si no, lo que dijo el servidor, o `fallback`.
 */
export function templateSendError(
  status: number | undefined,
  error: { code?: string; message?: string } | null | undefined,
  fallback: string,
  costs: TemplateCosts,
  category: string | null | undefined
): string {
  if (status === 402 || error?.code === "no_credit") return noCreditMessage(costs, category);
  return error?.message ?? fallback;
}

/** El mensaje cuando el servidor responde 402 `no_credit`: qué pasó, cuánto cuesta y qué sigue funcionando. */
export function noCreditMessage(costs: TemplateCosts, category: string | null | undefined): string {
  const cost = templateCostLabel(costs, category);
  return (
    `No tienes monedas suficientes para enviar esta plantilla${cost ? ` (cuesta ${cost})` : ""}. ` +
    "Los mensajes de texto dentro de las 24 h siguen funcionando. Recarga o espera la renovación de tu plan."
  );
}
