"use client";

import type { NodeProps } from "@xyflow/react";
import { describeStep } from "@/lib/automation-dto";
import { metaOfNode, type CanvasNodeData } from "@/lib/automation-canvas";
import { ICONS } from "../node-icons";
import { useCanvasRefs } from "../canvas-context";
import { NodeShell } from "./node-shell";

/** Enviar un mensaje de WhatsApp: vista previa del texto o de la plantilla. */
export function MessageNode({ data, selected }: NodeProps & { data: CanvasNodeData }) {
  const refs = useCanvasRefs();
  if (data.kind !== "step") return null;
  const { title, detail } = describeStep({ stepType: data.stepType, config: data.config }, refs.templates, refs);
  return (
    <NodeShell
      icon={ICONS[metaOfNode(data).icon]}
      tone={metaOfNode(data).tone}
      title={title}
      detail={detail ?? "Sin mensaje: configúralo en el panel."}
      selected={selected}
      issues={data.issues}
      outputs={[{ id: "default", label: "Siguiente" }]}
    />
  );
}
