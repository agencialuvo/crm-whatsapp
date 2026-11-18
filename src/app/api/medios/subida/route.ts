import { z } from "zod";
import { apiError, withAuth } from "@/lib/api";
import { MedioError, prepararSubida } from "@/server/medios/store";
import { r2Enabled } from "@/server/storage";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  nombre: z.string().trim().min(1).max(255),
  mime: z.string().trim().max(120),
  bytes: z.number().int().positive(),
  tipo: z.enum(["image", "video", "document"]).optional(),
  icono: z.boolean().optional(),
});

/**
 * 048 — Paso 1 de la subida directa a R2: valida el archivo con las mismas reglas que la subida por el servidor y
 * entrega una URL `PUT` firmada (15 min, con tipo y tamaño firmados). Los bytes NO pasan por este servidor.
 * Con R2 apagado responde 404: la pantalla sube por `POST /api/medios` como siempre.
 */
export const POST = withAuth(async (session, req: Request) => {
  if (!r2Enabled()) return apiError(404, "not_found", "No encontrado");
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return apiError(422, "invalid_body", "Faltan el nombre, el tipo o el tamaño del archivo.");
  const { nombre, mime, bytes, tipo, icono } = parsed.data;
  try {
    const out = await prepararSubida({
      organizationId: session.organizationId,
      userId: session.userId,
      nombre,
      mime,
      bytes,
      soloTipo: tipo,
      permitirSvg: icono === true && tipo === "image",
    });
    return Response.json(out, { status: 201 });
  } catch (err) {
    if (err instanceof MedioError) {
      return apiError(err.code === "too_large" ? 413 : err.code === "unavailable" ? 503 : 422, err.code, err.message);
    }
    throw err;
  }
});
