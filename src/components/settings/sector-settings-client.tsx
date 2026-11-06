"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/components/negocio/api";
import { SectorPicker } from "@/components/onboarding/sector-picker";
import { ORG_CONTEXT_CHANGED_EVENT, type BusinessSector } from "@/lib/business-sector";

/** Ajustes → Tipo de negocio: el mismo selector del asistente de la primera visita, para cambiarlo cuando se quiera. */
export function SectorSettingsClient({
  sectors,
  currentKey,
}: {
  sectors: BusinessSector[];
  currentKey: string;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(currentKey);
  const [selected, setSelected] = useState(currentKey);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch("/api/organization/sector", {
        method: "PUT",
        json: { action: "choose", categoryKey: selected },
      });
      setSaved(selected);
      setNotice("Listo: tu tipo de negocio se actualizó.");
      window.dispatchEvent(new Event(ORG_CONTEXT_CHANGED_EVENT));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar. Inténtalo de nuevo.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tipo de negocio</CardTitle>
        <CardDescription>
          Define los nombres que ve tu equipo (profesional, servicio, cliente) y los módulos del plan con el que
          empiezas. Si ya contrataste un plan, no cambia: solo cambian los nombres.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SectorPicker sectors={sectors} value={selected} onChange={setSelected} disabled={saving} />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm text-success-text">
            {notice}
          </p>
        )}
        <Button type="button" onClick={() => void save()} disabled={saving || selected === saved}>
          {saving ? "Guardando…" : "Guardar"}
        </Button>
      </CardContent>
    </Card>
  );
}
