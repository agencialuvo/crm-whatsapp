import Link from "next/link";
import { cn } from "@/lib/utils";

export type CitasTab = "sillas" | "calendario";

const TABS: { id: CitasTab; label: string }[] = [
  { id: "sillas", label: "Por barberos" },
  { id: "calendario", label: "Calendario general" },
];

/**
 * Módulo SALON — las dos vistas de Citas en una sola pantalla: la agenda por
 * sillas (la principal) y el calendario general con sus bloqueos. La pestaña
 * vive en la URL (`?pestana=`): recargar o compartir el enlace abre en el mismo
 * sitio. Son enlaces, no estado de cliente, así que funcionan sin JavaScript.
 */
export function CitasTabs({ active }: { active: CitasTab }) {
  return (
    <nav aria-label="Vistas de Citas" className="-mx-1 mt-3 flex gap-1 overflow-x-auto px-1 pb-0.5">
      {TABS.map((t) => {
        const current = t.id === active;
        return (
          <Link
            key={t.id}
            href={`/citas?pestana=${t.id}`}
            aria-current={current ? "page" : undefined}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-sm px-3 py-2 text-[13.5px] font-semibold transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              current
                ? "bg-brand-tint text-brand-text"
                : "text-text-2 hover:bg-accent hover:text-foreground"
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
