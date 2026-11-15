"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

/**
 * El Modo Visual se carga SOLO al abrirlo y sin SSR (spec 036, D13): `@xyflow/react` mide el DOM y pesa lo
 * suyo, y el resto de Automatizaciones no tiene por qué pagarlo.
 */
export const FlowCanvasLazy = dynamic(() => import("./flow-canvas").then((m) => m.FlowCanvas), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-72 items-center justify-center bg-subtle text-sm text-text-3" role="status">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Cargando el lienzo…
    </div>
  ),
});
