"use client";

import { useEffect, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import { Plus, X } from "lucide-react";
import { PALETTE, canInsertOnEdge } from "@/lib/automation-canvas";
import { cn } from "@/lib/utils";
import { useCanvasEdgeActions } from "./canvas-context";
import { ICONS, TONE_STYLES } from "./node-icons";

/** Qué pasos se pueden insertar en medio de una conexión: los de una sola salida «Siguiente». */
const INSERTABLE = PALETTE.filter((i) => i.kind === "step" && i.stepType && !i.soon && canInsertOnEdge(i.stepType));

/** Lo que el hook pone en `edge.data`: el rótulo de la rama (Sí, No, Confirma…), si la salida ramifica. */
export type VoceroEdgeData = { label?: string };

/**
 * La conexión del lienzo: la misma línea escalonada de siempre, con el rótulo de su rama cerca del origen y, al pasar
 * el cursor por encima o al seleccionarla, dos botones en el punto medio: insertar un paso en medio y eliminarla.
 * Son botones reales (teclado y lector de pantalla), y la Supr sigue funcionando.
 */
export function VoceroEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data }: EdgeProps) {
  const { deleteEdge, insertStepOnEdge, triggerType, disabled } = useCanvasEdgeActions();
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState(false);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (leave.current && clearTimeout(leave.current)), []);
  // Al soltar la selección el menú se cierra solo.
  useEffect(() => {
    if (!selected && !hover) setMenu(false);
  }, [selected, hover]);

  const [path, midX, midY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const label = (data as VoceroEdgeData | undefined)?.label;
  const show = !disabled && (selected || hover || menu);
  const isBooking = triggerType.startsWith("booking_");

  const enter = () => {
    if (leave.current) clearTimeout(leave.current);
    setHover(true);
  };
  // Una pequeña demora: el cursor cruza el hueco entre la línea y los botones sin que desaparezcan.
  const exit = () => {
    if (leave.current) clearTimeout(leave.current);
    leave.current = setTimeout(() => setHover(false), 180);
  };

  return (
    <>
      <g onMouseEnter={enter} onMouseLeave={exit}>
        <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={28} />
      </g>
      <EdgeLabelRenderer>
        {label && (
          <div
            className="nodrag nopan pointer-events-none absolute rounded-md border border-border-strong bg-background px-1.5 py-0.5 text-[11px] font-semibold text-text-2"
            style={{ transform: `translate(-50%, -50%) translate(${sourceX}px, ${sourceY + 22}px)` }}
          >
            {label}
          </div>
        )}
        {show && (
          <div
            className="nodrag nopan absolute z-10 flex flex-col items-center gap-1"
            style={{ pointerEvents: "all", transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)` }}
            onMouseEnter={enter}
            onMouseLeave={exit}
          >
            <div className="flex items-center gap-1 rounded-full border border-border-strong bg-card p-0.5 shadow-md">
              <button
                type="button"
                aria-label="Insertar un paso en esta conexión"
                aria-expanded={menu}
                title="Insertar un paso aquí"
                onClick={() => setMenu((m) => !m)}
                className="flex h-6 w-6 items-center justify-center rounded-full text-text-2 hover:bg-brand-tint hover:text-brand-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                aria-label="Eliminar esta conexión"
                title="Eliminar la conexión"
                onClick={() => deleteEdge(id)}
                className="flex h-6 w-6 items-center justify-center rounded-full text-danger-text hover:bg-danger-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
            {menu && (
              <ul
                aria-label="Paso a insertar"
                onKeyDown={(e) => e.key === "Escape" && setMenu(false)}
                className="max-h-56 w-52 overflow-y-auto rounded-lg border border-border-strong bg-popover p-1 shadow-pop"
              >
                {INSERTABLE.map((item) => {
                  const blocked = !!item.needsBooking && !isBooking;
                  const Icon = ICONS[item.icon];
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        disabled={blocked}
                        title={blocked ? "Solo en flujos de cita" : item.hint}
                        onClick={() => {
                          insertStepOnEdge(id, item.stepType!);
                          setMenu(false);
                        }}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          blocked ? "cursor-not-allowed text-text-4" : "hover:bg-accent"
                        )}
                      >
                        <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded", TONE_STYLES[item.tone].chip)}>
                          <Icon className="h-3 w-3" strokeWidth={1.8} aria-hidden />
                        </span>
                        {item.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
