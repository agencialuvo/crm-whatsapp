import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { CONNECTOR_ORDER } from "@/lib/agenda-connectors";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import {
  CalendarSettingsError,
  getSettings,
  upsertSettings,
} from "@/server/agenda/settings";
import { moduleGate } from "@/server/business/saas-guard";
import { resyncUpcomingBookings } from "@/server/agenda/calendar-sync/sync";
import { clearGoogleBusyBlocks, requestBusySync } from "@/server/agenda/calendar-busy/sync";

export const dynamic = "force-dynamic";

/**
 * 015 — La configuración de la agenda del negocio.
 *
 * Una instancia sin configurar responde 200 con los defaults, no 404: la
 * agenda ya es usable el día que se enciende.
 *
 * Jamás devuelve credenciales de un conector — esas viven en su propio
 * endpoint y solo salen como últimos 4 dígitos.
 */
export const GET = withAuth(async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const planBlocked = await moduleGate(session.organizationId, "agenda");
  if (planBlocked) return planBlocked;
  const settings = await getSettings(session.organizationId);
  return Response.json({ settings });
});

const intervalSchema = z.object({
  start: z.string(),
  end: z.string(),
});

const putSchema = z.object({
  weeklyHours: z.record(z.string(), z.array(intervalSchema)).optional(),
  slotMinutes: z.number().optional(),
  bufferMinutes: z.number().optional(),
  minNoticeHours: z.number().optional(),
  maxDaysAhead: z.number().optional(),
  timezone: z.string().optional(),
  // El catálogo manda: un conector que no existe se rechaza aquí, y el
  // servicio lo vuelve a comprobar por si el llamador no es esta ruta.
  connector: z
    .string()
    .refine((v) => (CONNECTOR_ORDER as readonly string[]).includes(v), {
      message: "Conector desconocido",
    })
    .optional(),
  meetingLink: z.string().nullish(),
  /** Paso 3: publicar las citas en Google Calendar y, opcionalmente, con el teléfono del cliente. */
  googleSync: z.boolean().optional(),
  googleSyncPhone: z.boolean().optional(),
  /** Paso 4: tener en cuenta lo ocupado en Google Calendar. */
  googleBusy: z.boolean().optional(),
});

/**
 * Guarda lo que se pueda salvar: los enteros fuera de rango se recortan y los
 * intervalos mal escritos se descartan, en vez de tumbar el horario entero por
 * una celda. Lo que sí se rechaza es lo que rompería el motor después: una
 * zona horaria que el runtime no conoce, o un conector inexistente.
 */
export const PUT = withAuth(async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const planBlocked = await moduleGate(session.organizationId, "agenda");
  if (planBlocked) return planBlocked;
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

  try {
    const before = await getSettings(session.organizationId);
    const settings = await upsertSettings(session.organizationId, {
      ...body.data,
      // `undefined` = no lo tocaron; `null` = lo vaciaron a propósito.
      meetingLink:
        body.data.meetingLink === undefined ? undefined : body.data.meetingLink,
    });
    // Encender la publicación (o cambiar qué se muestra) vuelve a publicar las citas que vienen.
    if (
      settings.googleSync &&
      (!before.googleSync || before.googleSyncPhone !== settings.googleSyncPhone)
    ) {
      await resyncUpcomingBookings(session.organizationId);
    }
    // Paso 4: encender la lectura lee ya (en segundo plano); apagarla quita lo que se había traído de Google.
    // Cambiar cuántos días se ofrecen cambia qué tramo hay que leer.
    if (settings.googleBusy && (!before.googleBusy || before.maxDaysAhead !== settings.maxDaysAhead)) {
      await requestBusySync(session.organizationId);
    } else if (!settings.googleBusy && before.googleBusy) {
      await clearGoogleBusyBlocks(session.organizationId);
    }
    return Response.json({ settings });
  } catch (err) {
    if (err instanceof CalendarSettingsError) {
      return apiError(422, "invalid_body", err.message);
    }
    throw err;
  }
});
