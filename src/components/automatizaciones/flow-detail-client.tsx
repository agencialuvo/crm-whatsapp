"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Clock, MessageCircle, Pencil, Plus, Trash2, Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { FlowDialog } from "@/components/automatizaciones/flow-dialog";
import { StepDialog } from "@/components/automatizaciones/step-dialog";
import { apiErrorStatus, apiFetch, describeError } from "@/components/negocio/api";
import { ConfirmDialog } from "@/components/negocio/modal";
import {
  activationBlock,
  describeStep,
  describeTrigger,
  reorderPositions,
  sortSteps,
  triggerLabel,
  type FlowDto,
  type StageOption,
  type StepDto,
  type TemplateOption,
} from "@/lib/automation-dto";
import { cn } from "@/lib/utils";

type StepDialogState = { step: StepDto | null } | null;

const STEP_ICON: Record<string, typeof Clock> = { delay: Clock, send_whatsapp: MessageCircle };

/**
 * Automatizaciones — un flujo: su nombre, cuándo se activa y sus reglas, y la secuencia de pasos que
 * ejecuta (en el orden en que se leen, de arriba abajo).
 *
 * Los pasos se agregan, editan, reordenan con las flechas y borran desde aquí. Encender el flujo exige
 * al menos un paso; borrar el último de un flujo encendido lo apaga (lo hace el servidor y aquí se refleja).
 */
export function FlowDetailClient({ flowId }: { flowId: string }) {
  const router = useRouter();
  const [flow, setFlow] = useState<FlowDto | null>(null);
  const [steps, setSteps] = useState<StepDto[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [stages, setStages] = useState<StageOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [editingFlow, setEditingFlow] = useState(false);
  const [stepDialog, setStepDialog] = useState<StepDialogState>(null);
  const [removeStep, setRemoveStep] = useState<StepDto | null>(null);
  const [removeFlow, setRemoveFlow] = useState(false);

  const ordered = useMemo(() => sortSteps(steps), [steps]);

  const load = useCallback(async () => {
    setLoadError(null);
    setNotFound(false);
    try {
      const [detail, tpl, st] = await Promise.all([
        apiFetch<{ flow: FlowDto; steps: StepDto[] }>(`/api/automations/${flowId}`),
        // Las plantillas y las etapas solo dan nombres: si fallan, el detalle se muestra igual.
        apiFetch<{ templates: TemplateOption[] }>("/api/templates").catch(() => ({ templates: [] as TemplateOption[] })),
        apiFetch<{ stages: StageOption[] }>("/api/pipeline/stages").catch(() => ({ stages: [] as StageOption[] })),
      ]);
      setFlow(detail.flow);
      setSteps(detail.steps);
      setTemplates(tpl.templates);
      setStages(st.stages);
    } catch (err) {
      if (apiErrorStatus(err) === 404) setNotFound(true);
      else setLoadError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [flowId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleActive(active: boolean) {
    if (!flow) return;
    setActionError(null);
    // La misma regla del servidor, avisada antes de pedirla.
    const block = active ? activationBlock(steps.length, flow.active) : null;
    if (block) {
      setActionError(block);
      return;
    }
    setToggling(true);
    try {
      const { flow: saved } = await apiFetch<{ flow: FlowDto }>(`/api/automations/${flow.id}`, {
        method: "PATCH",
        json: { active },
      });
      setFlow(saved);
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setToggling(false);
    }
  }

  const upsertStep = useCallback((saved: StepDto) => {
    setSteps((prev) => (prev.some((s) => s.id === saved.id) ? prev.map((s) => (s.id === saved.id ? saved : s)) : [...prev, saved]));
  }, []);

  /** Sube o baja un paso: reescribe las posiciones de los que cambian de lugar. */
  async function move(index: number, dir: -1 | 1) {
    const updates = reorderPositions(ordered, index, index + dir);
    if (updates.length === 0) return;
    setActionError(null);
    setReordering(true);
    try {
      for (const u of updates) {
        await apiFetch(`/api/automations/${flowId}/steps/${u.id}`, {
          method: "PATCH",
          json: { positionX: u.positionX, positionY: u.positionY },
        });
      }
      setSteps((prev) =>
        prev.map((s) => {
          const u = updates.find((x) => x.id === s.id);
          return u ? { ...s, positionX: u.positionX, positionY: u.positionY } : s;
        })
      );
    } catch (err) {
      setActionError(describeError(err));
      // Si falló a medias, lo que se ve debe ser lo que hay guardado.
      void load();
    } finally {
      setReordering(false);
    }
  }

  async function deleteStep(step: StepDto) {
    await apiFetch(`/api/automations/${flowId}/steps/${step.id}`, { method: "DELETE" });
    const left = steps.filter((s) => s.id !== step.id);
    setSteps(left);
    // El servidor apaga un flujo encendido que se queda sin pasos.
    if (left.length === 0) setFlow((f) => (f ? { ...f, active: false } : f));
  }

  async function deleteFlow() {
    await apiFetch(`/api/automations/${flowId}`, { method: "DELETE" });
    router.push("/automatizaciones");
  }

  const back = (
    <Link href="/automatizaciones" className="inline-flex items-center gap-1.5 text-sm text-text-3 hover:text-foreground">
      <ArrowLeft className="h-4 w-4" aria-hidden />
      Automatizaciones
    </Link>
  );

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4" aria-busy aria-label="Cargando">
        <div className="h-24 animate-pulse rounded-lg border bg-subtle" />
        {[0, 1].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg border bg-subtle" />
        ))}
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        {back}
        <div className="rounded-lg border border-dashed border-border-strong bg-card py-8">
          <EmptyState
            icon={Workflow}
            title="Este flujo no existe"
            description="Pudo haberse eliminado, o el enlace no es correcto."
            action={
              <Button onClick={() => router.push("/automatizaciones")}>
                Ver mis automatizaciones
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  if (loadError || !flow) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        {back}
        <div className="rounded-lg border border-danger-soft bg-danger-tint p-4 text-sm text-danger-text">
          <p>{loadError ?? "No se pudo cargar el flujo."}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
            Reintentar
          </Button>
        </div>
      </div>
    );
  }

  const block = activationBlock(steps.length, flow.active);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {back}

      <section className="rounded-lg border border-border-strong bg-card p-4 shadow-sm sm:p-5" aria-label="Datos del flujo">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="break-words text-lg font-bold tracking-tight">{flow.name}</h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{triggerLabel(flow.triggerType)}</Badge>
              <span className="text-sm text-text-2">{describeTrigger(flow.triggerType, flow.triggerConfig, stages)}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditingFlow(true)}>
              <Pencil className="h-4 w-4" aria-hidden />
              Editar
            </Button>
            <Button variant="outline" size="sm" onClick={() => setRemoveFlow(true)}>
              <Trash2 className="h-4 w-4 text-danger-text" aria-hidden />
              Eliminar flujo
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
          <Switch
            checked={flow.active}
            // Sin pasos no se puede encender; apagar siempre se puede.
            disabled={toggling || block !== null}
            label={`${flow.active ? "Apagar" : "Encender"} el flujo`}
            onCheckedChange={(v) => void toggleActive(v)}
          />
          {flow.active ? <Badge variant="success">Activo</Badge> : <Badge variant="secondary">Pausado</Badge>}
          <p className="text-xs text-text-3">
            {block ?? (flow.active ? "Se ejecuta solo cuando pasa lo que lo activa." : "No se ejecutará hasta que lo enciendas.")}
          </p>
        </div>
      </section>

      {actionError && (
        <p
          role="alert"
          className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text"
        >
          {actionError}
        </p>
      )}

      <section aria-label="Pasos del flujo" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-[15px] font-bold tracking-tight">
            Pasos <span className="font-normal text-text-3">({ordered.length})</span>
          </h3>
          <Button size="sm" onClick={() => setStepDialog({ step: null })}>
            <Plus className="h-4 w-4" aria-hidden />
            Agregar paso
          </Button>
        </div>

        {ordered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-strong bg-card py-8">
            <EmptyState
              icon={Workflow}
              title="Este flujo aún no tiene pasos"
              description="Agrega un mensaje de WhatsApp o una espera. Los pasos se ejecutan en orden, de arriba abajo."
              action={
                <Button onClick={() => setStepDialog({ step: null })}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Agregar paso
                </Button>
              }
            />
          </div>
        ) : (
          <ol className="space-y-0">
            {ordered.map((step, i) => {
              const { title, detail } = describeStep(step, templates);
              const Icon = STEP_ICON[step.stepType] ?? Workflow;
              const unsupported = !(step.stepType in STEP_ICON);
              return (
                <li key={step.id}>
                  <div
                    className={cn(
                      "flex items-start gap-3 rounded-lg border border-border-strong bg-card p-3 shadow-sm sm:p-4",
                      unsupported && "border-warning-soft bg-warning-tint"
                    )}
                  >
                    <span
                      aria-hidden
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-tint text-sm font-bold text-brand-text"
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 font-medium">
                        <Icon className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
                        <span className="break-words">{title}</span>
                      </p>
                      {detail && <p className="mt-1 break-words text-sm text-text-2">{detail}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Subir el paso ${i + 1}`}
                        title="Subir"
                        disabled={i === 0 || reordering}
                        onClick={() => void move(i, -1)}
                      >
                        <ArrowUp className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Bajar el paso ${i + 1}`}
                        title="Bajar"
                        disabled={i === ordered.length - 1 || reordering}
                        onClick={() => void move(i, 1)}
                      >
                        <ArrowDown className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Editar el paso ${i + 1}`}
                        title="Editar"
                        disabled={unsupported}
                        onClick={() => setStepDialog({ step })}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Eliminar el paso ${i + 1}`}
                        title="Eliminar"
                        onClick={() => setRemoveStep(step)}
                      >
                        <Trash2 className="h-4 w-4 text-danger-text" aria-hidden />
                      </Button>
                    </div>
                  </div>
                  {i < ordered.length - 1 && (
                    <div aria-hidden className="ml-7 h-4 w-px bg-border-strong" />
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {editingFlow && (
        <FlowDialog
          flow={flow}
          stages={stages}
          onClose={() => setEditingFlow(false)}
          onSaved={(saved) => {
            setFlow(saved);
            setEditingFlow(false);
          }}
        />
      )}

      {stepDialog && (
        <StepDialog
          flowId={flow.id}
          step={stepDialog.step}
          steps={steps}
          templates={templates}
          onClose={() => setStepDialog(null)}
          onSaved={(saved) => {
            upsertStep(saved);
            setStepDialog(null);
          }}
        />
      )}

      {removeStep && (
        <ConfirmDialog
          title="Eliminar paso"
          message={
            <>
              ¿Eliminar <strong>{describeStep(removeStep, templates).title}</strong>? Los mensajes de este paso que
              estén pendientes dejarán de salir.
              {steps.length === 1 && flow.active && " Como es el único paso, el flujo se apagará."} Esta acción no se
              puede deshacer.
            </>
          }
          confirmLabel="Eliminar"
          onClose={() => setRemoveStep(null)}
          onConfirm={() => deleteStep(removeStep)}
        />
      )}

      {removeFlow && (
        <ConfirmDialog
          title="Eliminar flujo"
          message={
            <>
              ¿Eliminar <strong>{flow.name}</strong>? Se borran también sus pasos, los mensajes pendientes y su
              historial de ejecución. Esta acción no se puede deshacer.
            </>
          }
          confirmLabel="Eliminar"
          onClose={() => setRemoveFlow(false)}
          onConfirm={deleteFlow}
        />
      )}
    </div>
  );
}
