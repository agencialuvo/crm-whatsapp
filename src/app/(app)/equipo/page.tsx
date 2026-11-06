import { NegocioPage } from "@/components/negocio/negocio-page";
import { StaffClient } from "@/components/negocio/staff-client";
import { WEEKDAYS } from "@/lib/time/slots";
import { getSettings } from "@/server/agenda/settings";
import { requireSalonPage } from "@/server/business/page-guard";

export const dynamic = "force-dynamic";

/** 0 = domingo … 6 = sábado, como `staff_schedule.day_of_week`. */
const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } as const;

/**
 * Módulo SALON — profesionales, horarios y comisiones. Solo dueño/administrador.
 *
 * Baja el horario del negocio (de Ajustes → Agenda) ya resumido por día, para
 * que quien arma el turno de alguien vea contra qué lo está comparando.
 */
export default async function EquipoPage() {
  const session = await requireSalonPage({ manage: true, module: "salon" });
  const settings = await getSettings(session.organizationId);
  const businessHours: Record<number, string> = {};
  for (const key of WEEKDAYS) {
    const intervals = settings.weeklyHours[key] ?? [];
    businessHours[DAY_INDEX[key]] =
      intervals.length === 0
        ? "Cerrado"
        : intervals.map((iv) => `${iv.start}–${iv.end}`).join(" · ");
  }
  return (
    <NegocioPage title="Equipo">
      <StaffClient businessHours={businessHours} />
    </NegocioPage>
  );
}
