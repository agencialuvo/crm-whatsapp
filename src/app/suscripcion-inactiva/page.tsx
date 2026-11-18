import { redirect } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { SubscriptionClient } from "@/components/billing/subscription-client";
import { billingEnabled } from "@/lib/mercadopago/config";
import { EmptyState } from "@/components/ui/empty-state";
import { getSessionOrNull } from "@/lib/auth/session";
import { statusLabelOf } from "@/lib/saas";
import { enforcementEnabled, getSubscriptionAccess } from "@/server/saas/enforcement";

export const dynamic = "force-dynamic";

/**
 * 045 — A donde llega una organización con la suscripción inactiva (con `SAAS_ENFORCE` encendido): la prueba
 * venció, o se suspendió o canceló. No consulta datos del negocio: solo dice qué pasó y cómo seguir. Si la
 * suscripción SÍ está al día (se reactivó entre tanto) no la retiene aquí. Los mensajes que sigan llegando
 * al WhatsApp del negocio se guardan igual: nada se pierde mientras se regulariza.
 */
export default async function SuscripcionInactivaPage() {
  const session = await getSessionOrNull();
  if (!session) redirect("/iniciar-sesion");
  const access = await getSubscriptionAccess(session.organizationId, new Date(), false);
  if (!enforcementEnabled() || !access.blocked) redirect("/");
  const motivo = access.status ? statusLabelOf(access.status, access.statusReason) : "Inactiva";
  // 046: con el cobro de Mercado Pago encendido, desde aquí se paga (solo el dueño; los demás ven a quién pedírselo).
  if (billingEnabled()) {
    return (
      <main className="mx-auto min-h-dvh max-w-3xl p-6" data-testid="subscription-inactive">
        <div className="mb-6 flex items-start gap-3">
          <LockKeyhole className="mt-1 h-6 w-6 text-text-3" aria-hidden />
          <div>
            <h1 className="text-xl font-bold">Tu suscripción no está activa</h1>
            <p className="text-sm text-text-3">
              Estado: <strong>{motivo}</strong>
              {access.planName ? ` · Plan ${access.planName}` : ""}. Elige un plan para seguir. Los mensajes que sigan llegando a tu WhatsApp se guardan; no se pierde nada mientras se regulariza.
            </p>
          </div>
        </div>
        <SubscriptionClient mode="blocked" isOwner={session.role === "owner"} />
      </main>
    );
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg items-center p-6" data-testid="subscription-inactive">
      <EmptyState
        icon={LockKeyhole}
        className="w-full"
        title="Tu suscripción no está activa"
        description={
          <>
            Estado: <strong>{motivo}</strong>
            {access.planName ? ` · Plan ${access.planName}` : ""}. Contacta a quien administra la plataforma para activar o renovar tu plan. Los mensajes que sigan
            llegando a tu WhatsApp se guardan; no se pierde nada mientras se regulariza.
          </>
        }
      />
    </main>
  );
}
