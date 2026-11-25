import { ROLE_LABELS, type NodeTone } from "@/lib/automation-canvas";
import { cn } from "@/lib/utils";
import { TONE_STYLES } from "./node-icons";

/**
 * El rol de un bloque en una palabra —Inicia, Decide, Espera, Actúa—, del color de su rol. Va en las tarjetas de la lista y
 * en el menú de insertar; en el lienzo el encabezado ya tiene el color, así que allí se pinta sin fondo (`plain`).
 */
export function RoleChip({ tone, plain = false, className }: { tone: NodeTone; plain?: boolean; className?: string }) {
  return (
    <span
      data-role={ROLE_LABELS[tone]}
      className={cn(
        "shrink-0 text-[10px] font-bold uppercase tracking-wide",
        plain ? "opacity-70" : cn("rounded px-1.5 py-0.5", TONE_STYLES[tone].chip),
        className
      )}
    >
      {ROLE_LABELS[tone]}
    </span>
  );
}
