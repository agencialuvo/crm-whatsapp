import { redirect } from "next/navigation";
import { LockKeyhole } from "lucide-react";
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
