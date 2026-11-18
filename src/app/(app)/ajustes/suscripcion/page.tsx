import { notFound, redirect } from "next/navigation";
import { SubscriptionClient } from "@/components/billing/subscription-client";
import { getSessionOrNull } from "@/lib/auth/session";
import { billingEnabled } from "@/lib/mercadopago/config";

export const dynamic = "force-dynamic";

/** 046 — Ajustes → Suscripción. Solo existe con `MERCADOPAGO` encendido (apagado: 404). */
export default async function SuscripcionPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  if (!billingEnabled()) notFound();
  const session = await getSessionOrNull();
  if (!session) redirect("/iniciar-sesion");
  const { checkout } = await searchParams;
  return <SubscriptionClient mode="page" isOwner={session.role === "owner"} checkoutId={checkout?.startsWith("bck_") ? checkout : null} />;
}
