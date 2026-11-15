"use client";

import type { ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import type { NodeIssues } from "@/lib/automation-canvas";
import { cn } from "@/lib/utils";
import type { EdgeHandle } from "@/lib/automation";

/** El color de la franja del encabezado por categoría: disparador, lógica/esperas o acción. */
export type NodeTone = "trigger" | "logic" | "action";
const TONE: Record<NodeTone, string> = {
  trigger: "bg-brand-tint text-brand-text",
  logic: "bg-warning-tint text-warning-text",
  action: "bg-subtle text-text-2",
};

/**
 * La carcasa común de todos los bloques del lienzo: encabezado con icono y título, cuerpo con el resumen de lo
 * configurado, insignia de problemas y las asas de salida rotuladas. Alto contraste y sin adornos.
 */
export function NodeShell({
  icon: Icon,
  title,
  detail,
  tone,
  selected,
  issues,
  target = true,
  outputs,
  width = "w-60",
  children,
}: {
  icon: LucideIcon;
  title: string;
  detail?: string | null;
  tone: NodeTone;
  selected?: boolean;
  issues?: NodeIssues;
  /** Asa de entrada (arriba). El disparador no tiene. */
  target?: boolean;
  /** Las salidas (abajo), con su rótulo. Una sola sin rótulo = el «siguiente» normal. */
  outputs: { id: EdgeHandle; label: string; tone?: "yes" | "no" }[];
  width?: string;
  children?: ReactNode;
}) {
  const errors = issues?.errors.length ?? 0;
  const warnings = issues?.warnings.length ?? 0;
  const labelled = outputs.length > 1;
  return (
    <div
      className={cn(
        "rounded-lg border bg-card text-left shadow-sm transition-shadow",
        width,
        selected ? "border-brand ring-2 ring-brand" : "border-border-strong",
        errors > 0 && "border-danger-soft",
        // El asa de salida cuelga del borde inferior: sin rótulos, la carcasa termina en el cuerpo.
        "relative"
      )}
    >
      {target && <Handle type="target" position={Position.Top} />}

      <div className={cn("flex items-center gap-2 rounded-t-lg px-3 py-2", TONE[tone])}>
        <Icon className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden />
        <p className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</p>
        {(errors > 0 || warnings > 0) && (
          <span
            title={[...(issues?.errors ?? []), ...(issues?.warnings ?? [])].join("\n")}
            className={cn("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold", errors > 0 ? "bg-danger-tint text-danger-text" : "bg-warning-tint text-warning-text")}
          >
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {errors + warnings}
          </span>
        )}
      </div>

      {(detail || children) && (
        <div className="space-y-1 px-3 py-2">
          {detail && <p className="line-clamp-3 break-words text-xs text-text-2">{detail}</p>}
          {children}
        </div>
      )}

      {labelled ? (
        <div className="flex border-t border-border-strong">
          {outputs.map((o) => (
            <div
              key={o.id}
              className={cn(
                "relative flex-1 px-1 pb-3 pt-1 text-center text-[10px] font-semibold",
                o.tone === "yes" ? "text-success-text" : o.tone === "no" ? "text-danger-text" : "text-text-3"
              )}
            >
              {o.label}
              <Handle type="source" position={Position.Bottom} id={o.id} />
            </div>
          ))}
        </div>
      ) : (
        outputs[0] && <Handle type="source" position={Position.Bottom} id={outputs[0].id} />
      )}
    </div>
  );
}
