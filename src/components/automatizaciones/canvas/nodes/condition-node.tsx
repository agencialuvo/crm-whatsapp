"use client";

import type { NodeProps } from "@xyflow/react";
import { GitBranch } from "lucide-react";
import { describeRule } from "@/lib/automation-dto";
import type { CanvasNodeData } from "@/lib/automation-canvas";
import { useCanvasRefs } from "../canvas-context";
import { NodeShell } from "./node-shell";

/** Condición Sí/No: muestra la regla que evalúa y dos asas rotuladas. */
export function ConditionNode({ data, selected }: NodeProps & { data: CanvasNodeData }) {
  const refs = useCanvasRefs();
  if (data.kind !== "step") return null;
  const rule = data.config.rule as Record<string, unknown> | undefined;
  return (
    <NodeShell
      icon={GitBranch}
      tone="logic"
      title="Condición"
      detail={describeRule(rule, refs)}
      selected={selected}
      issues={data.issues}
      outputs={[
        { id: "true", label: "Sí", tone: "yes" },
        { id: "false", label: "No", tone: "no" },
      ]}
    />
  );
}
