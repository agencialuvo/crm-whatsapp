"use client";

import type { NodeProps } from "@xyflow/react";
import { Flag, Tag } from "lucide-react";
import { describeStep } from "@/lib/automation-dto";
import type { CanvasNodeData } from "@/lib/automation-canvas";
import { useCanvasRefs } from "../canvas-context";
import { NodeShell } from "./node-shell";

/** Acciones sobre el CRM: asignar o quitar una etiqueta, cambiar de etapa. */
export function ActionNode({ data, selected }: NodeProps & { data: CanvasNodeData }) {
  const refs = useCanvasRefs();
  if (data.kind !== "step") return null;
  const { title, detail } = describeStep({ stepType: data.stepType, config: data.config }, refs.templates, refs);
  return (
    <NodeShell
      icon={data.stepType === "set_stage" ? Flag : Tag}
      tone="action"
      title={title}
      detail={detail}
      selected={selected}
      issues={data.issues}
      outputs={[{ id: "default", label: "Siguiente" }]}
    />
  );
}
