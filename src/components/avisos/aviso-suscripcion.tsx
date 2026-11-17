import { Hourglass } from "lucide-react";
import type { SubscriptionAccess } from "@/server/saas/enforcement";

/** Días de aviso antes de que termine la prueba. */
const AVISO_DIAS = 7;

/**
 * 045 — La franja de la prueba: «Tu prueba termina en N días» (en los últimos 7) o «Tu prueba terminó». Solo
 * informa: sin la bandera `SAAS_ENFORCE` no bloquea nada, y con ella la prueba vencida ni siquiera llega aquí
 * (la app manda a `/suscripcion-inactiva`). Sin descartar, como el aviso del agente: se va cuando se regulariza.
 */
export function AvisoSuscripcion({ access }: { access: SubscriptionAccess | null }) {
  if (!access) return null;
  const termino = access.status === "trial_expired" || (access.status === "past_due" && access.statusReason === "trial_ended");
  const porTerminar = access.status === "trialing" && access.daysLeft !== null && access.daysLeft <= AVISO_DIAS;
  if (!termino && !porTerminar) return null;
  const mensaje = termino
    ? "Tu prueba terminó. Contacta a quien administra la plataforma para activar tu plan."
    : `Tu prueba termina en ${access.daysLeft} ${access.daysLeft === 1 ? "día" : "días"}. Contacta a quien administra la plataforma para activar tu plan.`;
  return (
    <div
      role="status"
      data-aviso-suscripcion
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warning-soft bg-warning-tint px-4 py-2.5 text-[13px] text-warning-text"
    >
      <Hourglass className="h-4 w-4 shrink-0" strokeWidth={1.7} />
      <span className="min-w-0 flex-1">{mensaje}</span>
    </div>
  );
}
