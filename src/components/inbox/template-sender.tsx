"use client";

import { useEffect, useState } from "react";
import { templateLanguageName } from "@/lib/template-languages";
import type { TemplateDto } from "@/lib/types";
import { countVariables } from "@/lib/templates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchSelect } from "@/components/ui/search-select";

/**
 * Selector de plantilla aprobada para conversaciones con ventana cerrada
 * (FR-005/FR-051). Sin plantillas aprobadas muestra el estado vacío.
 */
export function TemplateSender({
  conversationId,
  onSent,
}: {
  conversationId: string;
  onSent: () => void;
}) {
  const [templates, setTemplates] = useState<TemplateDto[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [variables, setVariables] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/templates")
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((d: { templates?: TemplateDto[] }) => {
        if (!cancelled) {
          setTemplates(
            (d.templates ?? []).filter((t) => t.status === "approved")
          );
        }
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (templates === null) {
    return <p className="text-xs text-muted-foreground">Cargando plantillas…</p>;
  }

  if (templates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aún no hay plantillas aprobadas. Créalas en{" "}
        <a href="/ajustes/plantillas" className="text-primary hover:underline">
          Configuración → Plantillas
        </a>{" "}
        y espera la aprobación de Meta.
      </p>
    );
  }

  const selected = templates.find((t) => t.id === selectedId) ?? null;
  // El cuerpo puede llevar {{1}}..{{n}}: el número de parámetros es el índice
  // más alto, y Meta los exige todos.
  const variableCount = selected ? countVariables(selected.body) : 0;
  const values = Array.from({ length: variableCount }, (_, i) => variables[i] ?? "");
  const missingValue = values.some((v) => !v.trim());

  async function send() {
    if (!selected || sending) return;
    setSending(true);
    setError(null);
    const res = await fetch(
      `/api/conversations/${conversationId}/messages/template`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateId: selected.id,
          variables: variableCount > 0 ? values : undefined,
        }),
      }
    );
    setSending(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "No se pudo enviar la plantilla");
      return;
    }
    setSelectedId("");
    setVariables([]);
    onSent();
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="template-select" required>Plantilla aprobada</Label>
        <SearchSelect
          id="template-select"
          value={selectedId}
          onChange={(v) => {
            setSelectedId(v);
            setVariables([]);
          }}
          placeholder="Elige una plantilla…"
          options={templates.map((t) => ({
            value: t.id,
            label: `${t.name} (${templateLanguageName(t.language)})`,
          }))}
          searchPlaceholder="Buscar plantilla…"
          triggerClassName="bg-card"
        />
      </div>
      {selected && (
        <p className="rounded-md bg-subtle p-2.5 text-xs text-muted-foreground">
          {selected.body}
        </p>
      )}
      {values.map((value, i) => (
        <div key={i} className="space-y-1.5">
          <Label htmlFor={`template-variable-${i + 1}`} required>
            Valor de {`{{${i + 1}}}`}
          </Label>
          <Input
            id={`template-variable-${i + 1}`}
            value={value}
            onChange={(e) =>
              setVariables((prev) => {
                const next = [...prev];
                while (next.length < variableCount) next.push("");
                next[i] = e.target.value;
                return next;
              })
            }
            placeholder={
              i === 0 ? "p. ej. el nombre del cliente" : "p. ej. 12 de agosto"
            }
          />
        </div>
      ))}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button
        onClick={() => void send()}
        disabled={!selected || sending || missingValue}
      >
        {sending ? "Enviando…" : "Enviar plantilla"}
      </Button>
    </div>
  );
}
