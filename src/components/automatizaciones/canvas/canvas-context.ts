"use client";

import { createContext, useContext } from "react";
import type { MediaOption, StageOption, TagOption, TemplateOption } from "@/lib/automation-dto";

/**
 * Lo que los nodos y el panel necesitan para escribir nombres en vez de ids (etiquetas, etapas, plantillas): el
 * motor y el servidor trabajan por id, la pantalla muestra los nombres.
 */
export type CanvasRefs = { templates: TemplateOption[]; tags: TagOption[]; stages: StageOption[]; media: MediaOption[] };

export const CanvasRefsContext = createContext<CanvasRefs>({ templates: [], tags: [], stages: [], media: [] });
export const useCanvasRefs = (): CanvasRefs => useContext(CanvasRefsContext);

/**
 * Lo que las conexiones pueden hacer desde sus botones (eliminar, insertar un paso en medio). Aparte de `CanvasRefs`:
 * aquellos son datos para escribir nombres; estas son acciones sobre el grafo. Sin proveedor, no hacen nada.
 */
export type CanvasEdgeActions = {
  deleteEdge: (edgeId: string) => void;
  insertStepOnEdge: (edgeId: string, stepType: string) => void;
  /** El disparador del lienzo: decide qué pasos tienen sentido (los de cita solo en flujos de cita). */
  triggerType: string;
  disabled?: boolean;
};

export const CanvasEdgeActionsContext = createContext<CanvasEdgeActions>({
  deleteEdge: () => {},
  insertStepOnEdge: () => {},
  triggerType: "",
});
export const useCanvasEdgeActions = (): CanvasEdgeActions => useContext(CanvasEdgeActionsContext);
