import { notFound } from "next/navigation";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { staffInviteMessage } from "@/lib/staff-calendar";
import { staffCalendarsEnabled } from "@/server/agenda/staff-calendar/flag";

export const dynamic = "force-dynamic";

/** Mejora 3 — A donde vuelve el profesional después de Google: listo, o por qué no se conectó. */
export default async function ResultadoConexionPage({
  searchParams,
}: {
  searchParams: Promise<{ estado?: string; motivo?: string; negocio?: string; nombre?: string }>;
}) {
  if (!staffCalendarsEnabled()) notFound();
  const q = await searchParams;
  if (q.estado === "ok") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Listo{q.nombre ? `, ${q.nombre}` : ""}: tu calendario quedó conectado</CardTitle>
          <CardDescription>
            {q.negocio ?? "El negocio"} ya no te agendará citas cuando estés ocupado/a en tu Google Calendar. Puedes cerrar
            esta página.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>No se conectó tu calendario</CardTitle>
        <CardDescription>{staffInviteMessage(q.motivo)}</CardDescription>
      </CardHeader>
    </Card>
  );
}
