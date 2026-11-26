import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { staffInviteMessage } from "@/lib/staff-calendar";
import { staffCalendarsEnabled } from "@/server/agenda/staff-calendar/flag";
import { resolveInvite } from "@/server/agenda/staff-calendar/invite";

export const dynamic = "force-dynamic";

/**
 * Mejora 3 — La página del enlace de 24 h. Sin sesión: el enlace es la credencial. Dice qué negocio pide la
 * conexión, QUÉ se lee (solo los horarios ocupados; nada se escribe en su calendario) y lleva a Google.
 */
export default async function ConectarCalendarioPage({ params }: { params: Promise<{ token: string }> }) {
  if (!staffCalendarsEnabled()) notFound();
  const { token } = await params;
  const found = await resolveInvite(token);

  if (!found.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Este enlace ya no sirve</CardTitle>
          <CardDescription>{staffInviteMessage(found.reason)}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const { invite } = found;
  const vence = invite.expiresAt.toLocaleString("es", { dateStyle: "medium", timeStyle: "short" });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hola, {invite.staffName}</CardTitle>
        <CardDescription>
          {invite.organizationName} te pide conectar tu Google Calendar para no agendarte citas cuando estás
          ocupado/a.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="list-disc space-y-1 pl-5 text-sm text-text-2">
          <li>Solo se leen los horarios en que estás <strong>ocupado/a</strong>. Vocero no guarda títulos ni detalles.</li>
          <li>Nada se escribe en tu calendario y nadie recibe invitaciones.</li>
          <li>Lo marcado «Disponible» y las invitaciones que rechazas no cuentan.</li>
          <li>Puedes quitar el acceso cuando quieras desde tu cuenta de Google.</li>
        </ul>
        <a href={`/api/calendar-invite/${encodeURIComponent(token)}/start`} className={buttonVariants({ className: "w-full" })}>
          Conectar con Google
        </a>
        <p className="text-xs text-text-3">Este enlace es personal y vence el {vence}.</p>
      </CardContent>
    </Card>
  );
}
