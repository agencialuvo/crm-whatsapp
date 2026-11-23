import Link from "next/link";
import { requireSuperAdminPage } from "@/lib/auth/super-admin";

export const dynamic = "force-dynamic";

/**
 * 045 — Marco del panel de Super Admin: propio, SIN `AppShell` ni contexto de organización (el Super Admin
 * puede no pertenecer a ninguna). El gate corre aquí, en el servidor, antes de pintar nada: quien no es
 * Super Admin recibe un 404; sin 2FA, la página que explica cómo activarlo.
 */
export default async function SuperAdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const admin = await requireSuperAdminPage();
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-6">
        <div>
          <h1 className="text-[17px] font-bold tracking-tight">Super Admin</h1>
          <p className="text-xs text-text-3">Plataforma · planes y membresías</p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <nav className="flex items-center gap-3" aria-label="Secciones del panel">
            <Link href="/super-admin" className="font-medium text-brand-text hover:underline">
              Organizaciones
            </Link>
            <Link href="/super-admin/monedas" className="font-medium text-brand-text hover:underline" data-testid="nav-monedas">
              Monedas
            </Link>
          </nav>
          <span className="text-text-3" data-testid="admin-name">
            {admin.name}
          </span>
          {admin.hasOrganization && (
            <Link href="/" className="font-medium text-brand-text hover:underline">
              Volver a la app
            </Link>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] p-4 sm:p-6">{children}</main>
    </div>
  );
}
