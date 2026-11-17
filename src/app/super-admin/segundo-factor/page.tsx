import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSuperAdmin, SuperAdminDenied } from "@/lib/auth/super-admin";

export const dynamic = "force-dynamic";

/**
 * 045 — A donde llega un Super Admin que todavía no activó la verificación en dos pasos. Está FUERA del marco
 * del panel (si no, el gate del marco lo mandaría aquí otra vez, sin fin). Quien no es Super Admin ve un 404; si
 * ya tiene el segundo factor, vuelve al panel.
 */
export default async function SegundoFactorPage() {
  try {
    await requireSuperAdmin();
    redirect("/super-admin");
  } catch (err) {
    if (err instanceof SuperAdminDenied) {
      if (err.kind === "unauthenticated") redirect("/iniciar-sesion");
      if (err.kind === "not_found") notFound();
      return (
        <main className="mx-auto max-w-lg p-6" data-testid="two-factor-required">
          <EmptyState
            icon={ShieldAlert}
            title="Activa la verificación en dos pasos"
            description="El panel de Super Admin ve todas las cuentas de la plataforma, así que exige un segundo factor. Actívalo en Mi perfil y vuelve."
            action={
              <Link href="/ajustes/perfil" className="rounded-md border bg-secondary px-3 py-2 text-sm font-medium hover:bg-accent">
                Ir a Mi perfil
              </Link>
            }
          />
        </main>
      );
    }
    throw err;
  }
}
