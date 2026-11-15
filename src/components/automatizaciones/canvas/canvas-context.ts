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
