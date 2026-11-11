import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getSessionOrNull } from "@/lib/auth/session";
import { DEFAULT_BRANDING, isValidHex, resolveAccentSet } from "@/lib/branding";
import { CURRENCIES } from "@/lib/money";
import { isValidTimeZone } from "@/lib/time/slots";
import { getBranding, saveBranding } from "@/server/branding";

export const dynamic = "force-dynamic";

/** GET público: el login necesita la marca antes de autenticarse. */
export async function GET() {
  const session = await getSessionOrNull();
  // Sin sesión no hay negocio: la marca de la plataforma, no la del primero de la base.
  const branding = session ? await getBranding(session.organizationId) : DEFAULT_BRANDING;
  return Response.json({ branding, accentSet: resolveAccentSet(branding.accent) });
}

const putSchema = z.object({
  name: z.string().trim().min(1).max(30),
  accent: z.string().refine(isValidHex, "Color hex inválido (#rrggbb)"),
  /** La moneda del negocio: la única que el tablero suma. */
  currency: z.enum(CURRENCIES),
  /**
   * La zona horaria del negocio (IANA). Opcional: un cliente viejo que no la mande no la borra.
   * Es la que decide qué día es «hoy» en reportes, gastos y citas.
   */
  timezone: z
    .string()
    .trim()
    .refine(isValidTimeZone, "Zona horaria desconocida")
    .optional(),
});

export const PUT = withAuth(async (session, req: Request) => {
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Solo el propietario puede cambiar la marca");
  }
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;
  // El icono se conserva: este formulario es de nombre, color y moneda, y se
  // sube y se quita por su propia ruta. Sin esto, guardar el nombre borraría
  // el logo sin que nadie lo pidiera.
  const actual = await getBranding(session.organizationId);
  await saveBranding(session.organizationId, {
    ...body.data,
    favicon: actual.favicon,
    // Sin zona en el cuerpo se conserva la que ya había.
    timezone: body.data.timezone ?? actual.timezone ?? null,
  });
  return Response.json({ ok: true });
});
