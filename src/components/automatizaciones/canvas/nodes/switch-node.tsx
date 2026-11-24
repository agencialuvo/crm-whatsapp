"use client";

import type { NodeProps } from "@xyflow/react";
import { describeStep } from "@/lib/automation-dto";
import { metaOfNode, outputsOf, type CanvasNodeData } from "@/lib/automation-canvas";
import { ICONS } from "../node-icons";
import { useCanvasRefs } from "../canvas-context";
import { NodeShell } from "./node-shell";

/** Switch: una salida por caso (con su nombre) y «Otro». Solo existe en el lienzo. */
export function SwitchNode({ data, selected }: NodeProps & { data: CanvasNodeData }) {
  const refs = useCanvasRefs();
  if (data.kind !== "step") return null;
  const { title, detail } = describeStep({ stepType: "switch", config: data.config }, refs.templates, refs);
  return (
    <NodeShell
      icon={ICONS[metaOfNode(data).icon]}
      tone={metaOfNode(data).tone}
      title={title}
      detail={detail}
      selected={selected}
      issues={data.issues}
      width="w-80"
      outputs={outputsOf("switch", data.config)}
    />
  );
}
