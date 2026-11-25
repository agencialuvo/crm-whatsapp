"use client";

import type { NodeProps } from "@xyflow/react";
import { describeStep } from "@/lib/automation-dto";
import { metaOfNode, type CanvasNodeData } from "@/lib/automation-canvas";
import { ICONS } from "../node-icons";
import { useCanvasRefs } from "../canvas-context";
import { NodeShell } from "./node-shell";

/**
 * «Terminar flujo»: el cierre explícito de una rama. Tiene entrada pero NO salidas (nada sale de él), y por eso una salida
 * conectada aquí deja de avisar «el flujo termina ahí»: terminar es la decisión, no un descuido.
 */
export function EndNode({ data, selected }: NodeProps & { data: CanvasNodeData }) {
  const refs = useCanvasRefs();
  if (data.kind !== "step") return null;
  const { title, detail } = describeStep({ stepType: data.stepType, config: data.config }, refs.templates, refs);
  return (
    <NodeShell
      icon={ICONS[metaOfNode(data).icon]}
      tone={metaOfNode(data).tone}
      title={title}
      detail={detail}
      selected={selected}
      issues={data.issues}
      outputs={[]}
    />
  );
}
