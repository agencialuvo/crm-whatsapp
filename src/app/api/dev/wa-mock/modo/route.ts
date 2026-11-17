import { z } from "zod";
import { parseBody } from "@/lib/api";
import { mockGuard } from "@/lib/dev-guard";
import { getWaMockState } from "@/server/dev/wa-mock-state";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  modo: z.enum(["normal", "estadoprimero", "fallo", "colgado"]),
});

/**
 * 041 — Cambia cómo responde el mock de Graph al ENVÍO de mensajes, para que un guion E2E
 * pruebe la carrera del estado temprano, un fallo de Meta o una llamada colgada.
 */
export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  getWaMockState().modoEnvio = body.data.modo;
  return Response.json({ modo: body.data.modo });
}

export async function GET() {
  const guard = mockGuard();
  if (guard) return guard;
  return Response.json({ modo: getWaMockState().modoEnvio });
}

