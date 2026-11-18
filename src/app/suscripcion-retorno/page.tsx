import { notFound, redirect } from "next/navigation";
import { SubscriptionClient } from "@/components/billing/subscription-client";
import { getSessionOrNull } from "@/lib/auth/session";
import { billingEnabled } from "@/lib/mercadopago/config";

export const dynamic = "force-dynamic";

/**
 * 046 — A donde vuelve el cliente desde Mercado Pago (`back_url`). Vive FUERA de `(app)` a propósito: una
 * organización bloqueada por la prueba vencida no debe ser rebotada antes de confirmar su pago. Confirma el
 * cobro (consulta activa al servidor) y, al quedar pagado, lo lleva a la app.
 */
export default async function SuscripcionRetornoPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  if (!billingEnabled()) notFound();
  const session = await getSessionOrNull();
  if (!session) redirect("/iniciar-sesion");
  const { checkout } = await searchParams;
  return (
    <main className="mx-auto min-h-dvh max-w-3xl p-6" data-testid="subscription-return">
      <SubscriptionClient mode="blocked" isOwner={session.role === "owner"} checkoutId={checkout?.startsWith("bck_") ? checkout : null} />
    </main>
  );
}
