"use client";

import type { NodeProps } from "@xyflow/react";
import { Zap } from "lucide-react";
import { describeTrigger, triggerLabel } from "@/lib/automation-dto";
import type { CanvasNodeData } from "@/lib/automation-canvas";
import { useCanvasRefs } from "../canvas-context";
import { NodeShell } from "./node-shell";

/** El disparador del flujo: solo tiene asa de salida (la que marca el paso por el que arranca). */
export function TriggerNode({ data, selected }: NodeProps & { data: CanvasNodeData }) {
  const { stages } = useCanvasRefs();
  if (data.kind !== "trigger") return null;
  return (
    <NodeShell
      icon={Zap}
      tone="trigger"
      title={triggerLabel(data.triggerType)}
      detail={describeTrigger(data.triggerType, data.triggerConfig, stages)}
      selected={selected}
      issues={data.issues}
      target={false}
      outputs={[{ id: "default", label: "Siguiente" }]}
    />
  );
}
