"use client";

import type { NodeProps } from "@xyflow/react";
import { useEffect, useState } from "react";
import type { PickerNode } from "@/lib/ad-picker";
import { adScopeOf, parseAdReferralConfig } from "@/lib/automation";
import { describeTrigger, triggerLabel } from "@/lib/automation-dto";
import { fetchResolved } from "@/components/automatizaciones/ad-options-client";
import { metaOfNode, type CanvasNodeData } from "@/lib/automation-canvas";
import { ICONS } from "../node-icons";
import { useCanvasRefs } from "../canvas-context";
import { NodeShell } from "./node-shell";

/** El disparador del flujo: solo tiene asa de salida (la que marca el paso por el que arranca). */
export function TriggerNode({ data, selected }: NodeProps & { data: CanvasNodeData }) {
  const { stages, tags } = useCanvasRefs();
  // 047: el nombre VIVO del anuncio/conjunto/campaña elegido (se lee del catálogo; nunca se guarda en el flujo).
  const [adNode, setAdNode] = useState<PickerNode | null>(null);
  const adCfg = data.kind === "trigger" && data.triggerType === "ad_referral" ? parseAdReferralConfig(data.triggerConfig) : null;
  const adKey = adCfg ? JSON.stringify(adCfg) : "";
  useEffect(() => {
    let alive = true;
    if (!adCfg || adScopeOf(adCfg).level === "any") {
      setAdNode(null);
      return;
    }
    fetchResolved(adCfg)
      .then((n) => alive && setAdNode(n))
      .catch(() => alive && setAdNode(null));
    return () => {
      alive = false;
    };
    // `adKey` resume `adCfg`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adKey]);
  if (data.kind !== "trigger") return null;
  return (
    <NodeShell
      icon={ICONS[metaOfNode(data).icon]}
      tone={metaOfNode(data).tone}
      title={triggerLabel(data.triggerType)}
      detail={describeTrigger(data.triggerType, data.triggerConfig, stages, adNode, tags)}
      selected={selected}
      issues={data.issues}
      target={false}
      outputs={[{ id: "default", label: "Siguiente" }]}
    />
  );
}
