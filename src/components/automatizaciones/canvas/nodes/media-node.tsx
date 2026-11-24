"use client";

import type { NodeProps } from "@xyflow/react";
import { Film } from "lucide-react";
import { describeStep } from "@/lib/automation-dto";
import { metaOfNode, type CanvasNodeData } from "@/lib/automation-canvas";
import { ICONS } from "../node-icons";
import { useCanvasRefs } from "../canvas-context";
import { NodeShell } from "./node-shell";

/** Enviar una imagen o un video de la biblioteca: con su vista previa y la leyenda. */
export function MediaNode({ data, selected }: NodeProps & { data: CanvasNodeData }) {
  const refs = useCanvasRefs();
  if (data.kind !== "step") return null;
  const { title, detail } = describeStep({ stepType: data.stepType, config: data.config }, refs.templates, refs);
  const media = typeof data.config.mediaId === "string" ? refs.media.find((m) => m.id === data.config.mediaId) : undefined;
  return (
    <NodeShell
      icon={media?.tipo === "video" ? Film : ICONS[metaOfNode(data).icon]}
      tone={metaOfNode(data).tone}
      title={title}
      detail={detail}
      selected={selected}
      issues={data.issues}
      outputs={[{ id: "default", label: "Siguiente" }]}
    >
      {media ? (
        media.tipo === "video" ? (
          // `#t=0.1` pide un fotograma sin cargar el video entero; sin controles ni sonido: es solo la miniatura.
          <video
            src={`${media.ruta}#t=0.1`}
            preload="metadata"
            muted
            playsInline
            aria-label={`Vista previa de ${media.nombre}`}
            className="nodrag h-24 w-full rounded-md border bg-subtle object-cover"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={media.ruta} alt={`Vista previa de ${media.nombre}`} className="h-24 w-full rounded-md border bg-subtle object-cover" />
        )
      ) : (
        <p className="rounded-md border border-dashed px-2 py-3 text-center text-[11px] text-text-3">Elige un archivo en el panel.</p>
      )}
    </NodeShell>
  );
}
