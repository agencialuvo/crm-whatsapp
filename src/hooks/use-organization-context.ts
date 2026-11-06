"use client";

import { useState, useEffect } from "react";
import { ORG_CONTEXT_CHANGED_EVENT } from "@/lib/business-sector";

export type OrganizationContextData = {
  organizationId: string;
  organizationName: string;
  plan: {
    name: string;
    slug: string;
    features: {
      modules: string[];
      channels: string[];
    };
  };
  category: {
    key: string;
    name: string;
    labels: {
      staffName: string;
      serviceName: string;
      resourceName: string;
      clientName: string;
    };
  };
  customLabels: Record<string, string>;
};

export function useOrganizationContext() {
  const [context, setContext] = useState<OrganizationContextData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Cambiar el sector (o el plan) desde otra pantalla avisa por evento: el menú se entera sin recargar.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(ORG_CONTEXT_CHANGED_EVENT, bump);
    return () => window.removeEventListener(ORG_CONTEXT_CHANGED_EVENT, bump);
  }, []);

  useEffect(() => {
    async function fetchContext() {
      try {
        const response = await fetch("/api/organization/context");
        if (!response.ok) {
          throw new Error("No se pudo cargar el contexto de la organización");
        }
        const json = await response.json();
        setContext(json.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error desconocido");
      } finally {
        setLoading(false);
      }
    }

    fetchContext();
  }, [version]);

  // Etiquetas finales combinando las de la categoría con los overrides del usuario
  const labels = {
    staffName: context?.customLabels?.staffName || context?.category?.labels?.staffName || "Barbero",
    serviceName: context?.customLabels?.serviceName || context?.category?.labels?.serviceName || "Servicio",
    resourceName: context?.customLabels?.resourceName || context?.category?.labels?.resourceName || "Silla",
    clientName: context?.customLabels?.clientName || context?.category?.labels?.clientName || "Cliente",
  };

  return {
    context,
    labels,
    loading,
    error,
  };
}