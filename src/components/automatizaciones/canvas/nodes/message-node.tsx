"use client";

import type { NodeProps } from "@xyflow/react";
import { MessageCircle } from "lucide-react";
import { describeStep } from "@/lib/automation-dto";
import type { CanvasNodeData } from "@/lib/automation-canvas";
import { useCanvasRefs } from "../canvas-context";
import { NodeShell } from "./node-shell";

/** Enviar un mensaje de WhatsApp: vista previa del texto o de la plantilla. */
export function MessageNode({ data, selected }: NodeProps & { data: CanvasNodeData }) {
  const refs = useCanvasRefs();
  if (data.kind !== "step") return null;
  const { title, detail } = describeStep({ stepType: data.stepType, config: data.config }, refs.templates, refs);
  return (
    <NodeShell
      icon={MessageCircle}
      tone="action"
      title={title}
      detail={detail ?? "Sin mensaje: configúralo en el panel."}
      selected={selected}
      issues={data.issues}
      outputs={[{ id: "default", label: "Siguiente" }]}
    />
  );
}
