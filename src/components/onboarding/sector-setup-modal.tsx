"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { apiFetch } from "@/components/negocio/api";
import { SectorPicker } from "@/components/onboarding/sector-picker";
import { ORG_CONTEXT_CHANGED_EVENT, type BusinessSector } from "@/lib/business-sector";

/**
 * Asistente opcional de la primera visita: «¿Qué tipo de negocio tienes?». El registro no lo pregunta;
 * el negocio nace con el sector por defecto y esto deja personalizarlo. NUNCA bloquea: la X, Escape,
 * tocar fuera y «Configurar más tarde» cierran lo mismo (lo dejan en «para después» y no vuelve a
 * salir solo), y siempre se puede cambiar en Ajustes → Tipo de negocio.
 */
export function SectorSetupModal({
  sectors,
  currentKey,
}: {
  sectors: BusinessSector[];
  /** El sector con el que nació el negocio: queda preseleccionado. */
  currentKey: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState(currentKey);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Cierra YA y avisa al servidor sin esperarlo: un fallo de red no puede dejar la pantalla tapada. */
  function skip() {
    setOpen(false);
    void apiFetch("/api/organization/sector", { method: "PUT", json: { action: "skip" } }).catch(() => {});
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiFetch("/api/organization/sector", {
        method: "PUT",
        json: { action: "choose", categoryKey: selected },
      });
      // El plan pudo cambiar: el menú (candados «Pro») y el servidor lo releen.
      window.dispatchEvent(new Event(ORG_CONTEXT_CHANGED_EVENT));
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar. Inténtalo de nuevo.");
      setSaving(false);
    }
  }

  if (!open) return null;
  return (
    <Modal
      title="Personaliza tu espacio"
      description="Elige tu tipo de negocio y dejamos listos los módulos y los nombres que le corresponden. Puedes hacerlo después o cambiarlo cuando quieras en Ajustes."
      onClose={skip}
      busy={saving}
    >
      <SectorPicker sectors={sectors} value={selected} onChange={setSelected} disabled={saving} />
      <ModalFooter error={error}>
        <Button type="button" variant="ghost" onClick={skip} disabled={saving}>
          Configurar más tarde
        </Button>
        <Button type="button" onClick={() => void save()} disabled={saving || !selected}>
          {saving ? "Guardando…" : "Guardar y continuar"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
