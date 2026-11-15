"use client";

import type { NodeProps } from "@xyflow/react";
import { CalendarClock, Clock } from "lucide-react";
import { describeStep } from "@/lib/automation-dto";
import { outputsOf, type CanvasNodeData } from "@/lib/automation-canvas";
import { useCanvasRefs } from "../canvas-context";
import { NodeShell } from "./node-shell";

/** Esperar un tiempo (con ventana horaria) o hasta la cita; esta última suma el asa «Si ya pasó». */
export function WaitNode({ data, selected }: NodeProps & { data: CanvasNodeData }) {
  const refs = useCanvasRefs();
  if (data.kind !== "step") return null;
  const { title, detail } = describeStep({ stepType: data.stepType, config: data.config }, refs.templates, refs);
  return (
    <NodeShell
      icon={data.stepType === "wait_until" ? CalendarClock : Clock}
      tone="logic"
      title={title}
      detail={detail}
      selected={selected}
      issues={data.issues}
      outputs={outputsOf(data.stepType)}
    />
  );
}
