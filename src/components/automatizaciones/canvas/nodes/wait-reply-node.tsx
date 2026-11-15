"use client";

import type { NodeProps } from "@xyflow/react";
import { MessageSquareReply } from "lucide-react";
import { describeTimeout } from "@/lib/automation-dto";
import { REPLY_TIMEOUT_DEFAULT_MINUTES } from "@/lib/automation";
import { outputsOf, type CanvasNodeData } from "@/lib/automation-canvas";
import { NodeShell } from "./node-shell";

/** Esperar la respuesta del cliente: el tiempo límite y las cinco salidas (confirma, no, reagendar, otra cosa, sin respuesta). */
export function WaitReplyNode({ data, selected }: NodeProps & { data: CanvasNodeData }) {
  if (data.kind !== "step") return null;
  const minutes = typeof data.config.timeoutMinutes === "number" ? data.config.timeoutMinutes : REPLY_TIMEOUT_DEFAULT_MINUTES;
  return (
    <NodeShell
      icon={MessageSquareReply}
      tone="logic"
      title="Esperar respuesta"
      detail={`Hasta ${describeTimeout(minutes)}`}
      selected={selected}
      issues={data.issues}
      width="w-80"
      outputs={outputsOf("wait_reply")}
    />
  );
}
