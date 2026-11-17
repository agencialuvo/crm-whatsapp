import { withSuperAdmin } from "@/lib/auth/super-admin";
import { listPlans } from "@/server/super-admin/directory";

export const dynamic = "force-dynamic";

/** Los planes activos, para el selector del panel. */
export const GET = withSuperAdmin(async () => Response.json({ plans: await listPlans() }));
