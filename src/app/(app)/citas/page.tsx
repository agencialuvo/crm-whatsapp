import { notFound, redirect } from "next/navigation";
import { BookingsClient } from "@/components/bookings/bookings-client";
import { BoardClient } from "@/components/negocio/board-client";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { CitasTabs, type CitasTab } from "@/components/negocio/citas-tabs";
import { canConfigure } from "@/lib/auth/roles";
import { getSessionOrNull } from "@/lib/auth/session";
import { clampListTo, isCalendarView, isIsoDate } from "@/lib/time/calendar";
import { todayInTz } from "@/lib/time/slots";
import { agendaEnabled } from "@/server/agenda/flag";
import { getSettings } from "@/server/agenda/settings";
import { getBranding } from "@/server/branding";
import { salonEnabled } from "@/server/business/flag";

export const dynamic = "force-dynamic";

type Params = {
  vista?: string;
  fecha?: string;
  desde?: string;
  hasta?: string;
  pestana?: string;
  agendar?: string;
  /** Una cita a abrir al cargar (desde una notificación). */
  cita?: string;
};

/**
 * 215 — Citas en calendario. La vista y la fecha viven en la URL
 * (`?vista=semana&fecha=2026-09-18`, o `desde`/`hasta` en la Lista) para que
 * recargar o compartir el enlace abra en el mismo sitio.
 *
 * Con el módulo SALON, Citas es UNA pantalla con dos pestañas
 * (`?pestana=sillas|calendario`): la **vista por sillas** (agenda por
 * profesionales, cupos en vivo y «Agendar cita»), que es la principal, y el
 * **calendario general** con sus bloqueos. Sin SALON es el calendario de
 * siempre, sin pestañas.
 *
 * "Hoy" se decide aquí, en la zona del NEGOCIO: el navegador de quien mira
 * puede estar en otra.
 */
export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  // Sin la bandera esta pantalla no existe en esta instancia.
  if (!agendaEnabled()) notFound();
  const session = await getSessionOrNull();
  if (!session) redirect("/iniciar-sesion");

  const settings = await getSettings(session.organizationId);
  const params = await searchParams;
  const view = isCalendarView(params.vista) ? params.vista : null;
  const listFrom = isIsoDate(params.desde) ? params.desde : null;
  const date =
    view === "lista" && listFrom
      ? listFrom
      : isIsoDate(params.fecha)
        ? params.fecha
        : todayInTz(new Date(), settings.timezone);

  const calendar = (
    <BookingsClient
      initialView={view}
      initialDate={date}
      initialListTo={
        view === "lista" && isIsoDate(params.hasta)
          ? clampListTo(date, params.hasta)
          : null
      }
      timezone={settings.timezone}
      weeklyHours={settings.weeklyHours}
      embedded={salonEnabled()}
    />
  );

  if (!salonEnabled()) return calendar;

  // Un enlace viejo con `?vista=`/`?desde=` pertenece al calendario general.
  const tab: CitasTab =
    params.pestana === "sillas" || params.pestana === "calendario"
      ? params.pestana
      : params.vista || params.desde
        ? "calendario"
        : "sillas";

  const { currency } = await getBranding(session.organizationId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b px-4 pt-3 sm:px-6 sm:pt-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[17px] font-bold tracking-tight">Citas</h2>
          <NotificationBell />
        </div>
        <CitasTabs active={tab} />
      </header>
      {tab === "calendario" ? (
        <div className="min-h-0 flex-1">{calendar}</div>
      ) : (
        <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <BoardClient
            currency={currency}
            timezone={settings.timezone}
            today={todayInTz(new Date(), settings.timezone)}
            initialDate={isIsoDate(params.fecha) ? params.fecha : undefined}
            openNewOnLoad={params.agendar === "1"}
            openBookingId={params.cita}
            canManage={canConfigure(session.role)}
          />
        </div>
      )}
    </div>
  );
}
