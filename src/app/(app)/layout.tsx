import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { getSessionOrNull } from "@/lib/auth/session";
import { getBranding } from "@/server/branding";
import { accentCssVariables } from "@/lib/branding";
import { AppShell } from "@/components/app-shell";
import { agendaEnabled } from "@/server/agenda/flag";
import { salonEnabled } from "@/server/business/flag";
import { automationsEnabled } from "@/server/automation/flag";
import { avisoIaDe } from "@/server/ai/aviso";
import { AvisoIaBanner } from "@/components/avisos/aviso-ia";
import { AvisoSuscripcion } from "@/components/avisos/aviso-suscripcion";
import { AvisoMonedasBanner } from "@/components/avisos/aviso-monedas";
import { avisoMonedasDe } from "@/server/saas/credits-summary";
import { enforcementEnabled, getSubscriptionAccess } from "@/server/saas/enforcement";
import { TimezoneDetector } from "@/components/onboarding/timezone-detector";
import { isTimezoneConfigured } from "@/server/timezone";
import { SectorSetupModal } from "@/components/onboarding/sector-setup-modal";
import { canConfigure } from "@/lib/auth/roles";
import { getSectorSetup, listBusinessSectors } from "@/server/business/sector-setup";
import { getMenuConfig } from "@/server/business/menu-config";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSessionOrNull();
  if (!session) redirect("/iniciar-sesion");
  // 045: con `SAAS_ENFORCE` encendido, una suscripción vencida, suspendida o cancelada no entra a la app. Apagado
  // (lo normal) solo se muestra el aviso de la prueba. Un fallo de lectura jamás tumba la app.
  const suscripcion = await getSubscriptionAccess(session.organizationId).catch(() => null);
  if (suscripcion?.blocked && enforcementEnabled()) redirect("/suscripcion-inactiva");
  const branding = await getBranding(session.organizationId);
  const authSession = await getAuth().api.getSession({
    headers: await headers(),
  });
  // El agente encendido y sin con qué pensar se ve desde fuera igual que un
  // bot roto. Se resuelve en el servidor y en el layout para que se vea desde
  // CUALQUIER pantalla, no solo desde el panel de un contacto (#85).
  const aviso = await avisoIaDe(session.organizationId);
  // Monedas: solo con el corte activo y sin saldo. Apagadas (lo normal) o en modo sombra, no consulta nada y no aparece.
  const avisoMonedas = await avisoMonedasDe(session.organizationId);
  // El menú personalizado baja ya resuelto desde el servidor: así la barra nace con su orden y sus nombres, sin
  // parpadear del menú estándar al personalizado. Un fallo de lectura deja el menú estándar.
  const menuConfig = await getMenuConfig(session.organizationId);
  // Asistente de sector: solo quien configura, y solo mientras el negocio no haya elegido ni lo haya dejado
  // para después. Un fallo aquí (p. ej. migración pendiente) nunca tumba la app: simplemente no se ofrece.
  const sectorSetup = canConfigure(session.role)
    ? await getSectorSetup(session.organizationId).catch(() => null)
    : null;
  const sectorsToOffer =
    sectorSetup?.status === "pending" ? await listBusinessSectors().catch(() => []) : [];

  // Sin zona horaria elegida, quien administra informa la de su país (la del navegador). Un fallo no tumba nada.
  const detectTimezone = canConfigure(session.role)
    ? !(await isTimezoneConfigured(session.organizationId).catch(() => true))
    : false;

  return (
    <>
      {detectTimezone && <TimezoneDetector />}
      {/* Acento white-label inyectado en SSR, solo dentro del sistema. */}
      <style dangerouslySetInnerHTML={{ __html: accentCssVariables(branding.accent) }} />
      <AppShell
        branding={branding}
        userName={authSession?.user.name ?? "Usuario"}
        userImage={authSession?.user.image ?? null}
        role={session.role}
        // Qué módulos opcionales existen se decide en el servidor y baja por
        // prop, igual que los canales de la Bandeja. El nav es un componente de
        // cliente: no puede —ni debe— leer variables de entorno.
        agenda={agendaEnabled()}
        salon={salonEnabled()}
        automations={automationsEnabled()}
        menuConfig={menuConfig}
        aviso={
          <>
            <AvisoSuscripcion access={suscripcion} />
            <AvisoIaBanner aviso={aviso} />
            <AvisoMonedasBanner aviso={avisoMonedas} puedeConfigurar={canConfigure(session.role)} />
          </>
        }
      >
        {children}
      </AppShell>
      {sectorSetup?.status === "pending" && sectorsToOffer.length > 0 && (
        <SectorSetupModal sectors={sectorsToOffer} currentKey={sectorSetup.categoryKey} />
      )}
    </>
  );
}
