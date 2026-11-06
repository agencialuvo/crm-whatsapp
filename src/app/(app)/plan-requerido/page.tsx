import Link from "next/link";
import { redirect } from "next/navigation";
import { Lock } from "lucide-react";
import { NegocioPage } from "@/components/negocio/negocio-page";
import { EmptyState } from "@/components/ui/empty-state";
import { canConfigure } from "@/lib/auth/roles";
import { getSessionOrNull } from "@/lib/auth/session";
import { isPlanModule, PLAN_MODULE_LABEL } from "@/lib/plan-modules";
import { agendaEnabled } from "@/server/agenda/flag";
import { getPlanAccess } from "@/server/business/saas-guard";

export const dynamic = "force-dynamic";

/**
 * A donde llegan las pantallas que el plan de suscripción no incluye (`requirePlanModule`).
 * No consulta datos del módulo: solo dice qué falta y cómo seguir. Si el plan SÍ lo incluye
 * (se mejoró entre tanto, o alguien llegó por un enlace viejo) no lo retiene aquí.
 */
export default async function PlanRequeridoPage({
  searchParams,
}: {
  searchParams: Promise<{ modulo?: string }>;
}) {
  const session = await getSessionOrNull();
  if (!session) redirect("/iniciar-sesion");
  const { modulo } = await searchParams;
  const access = await getPlanAccess(session.organizationId);
  const moduleName = isPlanModule(modulo) ? modulo : null;
  if (moduleName && (access.unrestricted || access.modules.includes(moduleName))) redirect("/");

  const what = moduleName ? PLAN_MODULE_LABEL[moduleName] : "Este módulo";
  const manager = canConfigure(session.role);
  return (
    <NegocioPage title="Mejora tu plan">
      <EmptyState
        icon={Lock}
        title={`${what} no está incluido en tu plan ${access.planName}`}
        description={
          manager
            ? "Mejora tu plan para activarlo. Tus datos están a salvo: al activarlo vuelves a verlo todo como lo dejaste."
            : "Pídele al propietario o a un administrador que mejore el plan para activarlo."
        }
        action={
          <Link
            href={agendaEnabled() ? "/citas" : "/contactos"}
            className="text-sm font-semibold text-brand-text underline-offset-4 hover:underline"
          >
            Volver a lo que sí incluye tu plan
          </Link>
        }
        className="py-16"
      />
    </NegocioPage>
  );
}
