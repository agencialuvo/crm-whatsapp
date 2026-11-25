"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/components/negocio/api";
import type { LoyaltyMilestoneOption } from "@/lib/automation";

/**
 * Los hitos del programa de fidelidad (`/api/automations/loyalty-milestones`), cargados una vez cuando `enabled`.
 * `null` = todavía no se sabe (cargando o falló): quien lo usa no debe avisar nada ni bloquear nada con eso.
 */
export function useLoyaltyMilestones(enabled: boolean): LoyaltyMilestoneOption[] | null {
  const [milestones, setMilestones] = useState<LoyaltyMilestoneOption[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let vivo = true;
    apiFetch<{ milestones: LoyaltyMilestoneOption[] }>("/api/automations/loyalty-milestones")
      .then((r) => vivo && setMilestones(r.milestones))
      .catch(() => vivo && setMilestones(null));
    return () => {
      vivo = false;
    };
  }, [enabled]);
  return milestones;
}
