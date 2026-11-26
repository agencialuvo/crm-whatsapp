import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Conectar tu Google Calendar",
  // El enlace es personal: no se indexa.
  robots: { index: false, follow: false },
};

/**
 * Mejora 3 — Las páginas PÚBLICAS del enlace para que un profesional conecte su Google Calendar (no tiene
 * usuario en Vocero). Misma escenografía que la entrada a la app.
 */
export default function ConectarCalendarioLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      <div className="brand-grid absolute inset-0" aria-hidden />
      <div className="brand-glow brand-glow-a" aria-hidden />
      <div className="brand-glow brand-glow-b" aria-hidden />
      <div className="relative w-full max-w-md">{children}</div>
    </main>
  );
}
