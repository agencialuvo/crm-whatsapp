import { paymentGraceDays } from "@/lib/mercadopago/config";
import { getBillingStatus } from "@/server/billing/queries";
import { withBilling } from "@/server/billing/guard";

export const dynamic = "force-dynamic";

/** La pantalla de suscripción: estado, planes de pago y cobros de la organización de la sesión. */
export const GET = withBilling(async (session) => Response.json(await getBillingStatus(session.organizationId, paymentGraceDays())));
