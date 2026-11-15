"use client";

import { Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StepDialog } from "@/components/automatizaciones/step-dialog";
import { stepLabel, triggerLabel, type MediaOption, type StageOption, type StepDto, type TagOption, type TemplateOption } from "@/lib/automation-dto";
import type { CanvasNodeData } from "@/lib/automation-canvas";
import { TriggerInspector } from "./trigger-inspector";

/**
 * El panel derecho: configura el bloque seleccionado SIN modal. Para los pasos reutiliza el formulario de
 * `step-dialog.tsx` (modo `inline`), así las reglas son las mismas que en el Modo Simple; los cambios válidos se
 * aplican en vivo al lienzo y se guardan con «Guardar».
 */
export function InspectorPanel({
  nodeId,
  data,
  flowId,
  templates,
  tags,
  stages,
  media,
  triggerType,
  onTagCreated,
  onStepConfig,
  onTriggerType,
  onTriggerConfig,
  onDelete,
  onClose,
}: {
  nodeId: string;
  data: CanvasNodeData;
  flowId: string;
  templates: TemplateOption[];
  tags: TagOption[];
  stages: StageOption[];
  media?: MediaOption[];
  /** El disparador del lienzo (puede ser distinto del guardado si aún no se guarda). */
  triggerType: string;
  onTagCreated: (tag: TagOption) => void;
  onStepConfig: (id: string, config: Record<string, unknown>) => void;
  onTriggerType: (type: string) => void;
  onTriggerConfig: (config: Record<string, unknown> | null) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const isTrigger = data.kind === "trigger";
  const title = data.kind === "trigger" ? `Disparador · ${triggerLabel(data.triggerType)}` : stepLabel(data.stepType);
  const issues = data.issues;

  return (
    <aside
      aria-label="Configuración del bloque"
      className="flex max-h-[45%] shrink-0 flex-col overflow-hidden border-t border-border-strong bg-card lg:max-h-none lg:w-[360px] lg:border-l lg:border-t-0"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border-strong px-4 py-3">
        <h4 className="min-w-0 truncate text-sm font-bold tracking-tight">{title}</h4>
        <div className="flex shrink-0 items-center gap-1">
          {!isTrigger && (
            <Button variant="outline" size="sm" onClick={() => onDelete(nodeId)} aria-label="Eliminar bloque">
              <Trash2 className="h-4 w-4 text-danger-text" aria-hidden />
            </Button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar el panel"
            className="rounded p-1.5 text-text-3 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {issues && (issues.errors.length > 0 || issues.warnings.length > 0) && (
          <ul className="space-y-1.5" aria-label="Problemas del bloque">
            {issues.errors.map((m) => (
              <li key={m} className="rounded-md border border-danger-soft bg-danger-tint px-2.5 py-1.5 text-xs text-danger-text">
                {m}
              </li>
            ))}
            {issues.warnings.map((m) => (
              <li key={m} className="rounded-md border border-warning-soft bg-warning-tint px-2.5 py-1.5 text-xs text-warning-text">
                {m}
              </li>
            ))}
          </ul>
        )}

        {data.kind === "trigger" ? (
          <TriggerInspector
            triggerType={data.triggerType}
            triggerConfig={data.triggerConfig}
            stages={stages}
            onChangeType={onTriggerType}
            onChangeConfig={onTriggerConfig}
          />
        ) : (
          <StepDialog
            // Un bloque distinto monta un formulario nuevo con SU configuración.
            key={nodeId}
            inline
            flowId={flowId}
            step={{ id: nodeId, flowId, stepType: data.stepType, config: data.config, positionX: 0, positionY: 0 } satisfies StepDto}
            templates={templates}
            tags={tags}
            stages={stages}
            media={media}
            triggerType={triggerType}
            onTagCreated={onTagCreated}
            onApply={(config) => onStepConfig(nodeId, config)}
          />
        )}
      </div>
    </aside>
  );
}
