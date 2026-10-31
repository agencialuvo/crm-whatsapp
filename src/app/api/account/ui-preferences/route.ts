import { parseBody, withAuth } from "@/lib/api";
import { setTablePageSizeInputSchema } from "@/lib/salon/cash-shifts";
import { salonErrorResponse } from "@/server/business/http";
import { getTablePageSizes, setTablePageSize } from "@/server/business/ui-preferences";

export const dynamic = "force-dynamic";

/** Mis filas por página guardadas, por vista. Es de quien inició sesión, sea cual sea su rol. */
export const GET = withAuth(async (session) => {
  return Response.json({ tablePageSizes: await getTablePageSizes(session.organizationId, session.userId) });
});

/** Guarda las filas por página de UNA vista sin tocar las demás. */
export const PUT = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, setTablePageSizeInputSchema);
  if (!body.ok) return body.response;
  try {
    const tablePageSizes = await setTablePageSize(session.organizationId, session.userId, body.data);
    return Response.json({ tablePageSizes });
  } catch (err) {
    return salonErrorResponse(err);
  }
});
