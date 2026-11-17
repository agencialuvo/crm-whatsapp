import { withAuth } from "@/lib/api";
import { unreadTotal } from "@/server/inbox/queries";

export const dynamic = "force-dynamic";

/** 042 — El número de la barra lateral: la suma de no leídos, sin descargar la lista. */
export const GET = withAuth(async (session) => {
  return Response.json({ unread: await unreadTotal(session.organizationId) });
});
