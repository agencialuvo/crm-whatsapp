"use client";

import { useMemo } from "react";

// Etiquetas por defecto (fallback tipo salón/barbería)
const DEFAULT_LABELS = {
  staffName: "Barbero",
  serviceName: "Servicio",
  resourceName: "Silla",
  clientName: "Cliente",
};

export type BusinessLabels = typeof DEFAULT_LABELS;

/**
 * Hook para obtener las etiquetas dinámicas del negocio actual.
 * Recibe las etiquetas de la categoría y los customLabels guardados por la organización.
 */
export function useBusinessLabels(
  categoryLabels?: Partial<BusinessLabels>,
  customLabels?: Record<string, string>
): BusinessLabels {
  return useMemo(() => {
    return {
      staffName: customLabels?.staffName || categoryLabels?.staffName || DEFAULT_LABELS.staffName,
      serviceName: customLabels?.serviceName || categoryLabels?.serviceName || DEFAULT_LABELS.serviceName,
      resourceName: customLabels?.resourceName || categoryLabels?.resourceName || DEFAULT_LABELS.resourceName,
      clientName: customLabels?.clientName || categoryLabels?.clientName || DEFAULT_LABELS.clientName,
    };
  }, [categoryLabels, customLabels]);
}