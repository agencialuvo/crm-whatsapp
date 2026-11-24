import {
  ArrowRightLeft,
  Cake,
  CalendarCheck,
  CalendarClock,
  CalendarPlus,
  CalendarX,
  Gift,
  Play,
  Clock,
  Eraser,
  Flag,
  GitBranch,
  Image as ImageIcon,
  Megaphone,
  MessageCircle,
  MessageSquareReply,
  Tag,
  UserPlus,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { IconName, NodeTone } from "@/lib/automation-canvas";

/** Nombre de icono (de los metadatos puros) → componente de `lucide-react`. */
export const ICONS: Record<IconName, LucideIcon> = {
  Zap,
  UserPlus,
  ArrowRightLeft,
  Megaphone,
  CalendarPlus,
  CalendarCheck,
  CalendarX,
  Cake,
  Gift,
  Play,
  GitBranch,
  Clock,
  CalendarClock,
  MessageSquareReply,
  MessageCircle,
  Image: ImageIcon,
  Tag,
  Eraser,
  Flag,
};

/**
 * Los colores de cada rol, con las clases completas (Tailwind no ve las que se arman por partes):
 * `head` el encabezado del bloque, `bar` su borde izquierdo, `chip` el icono en la paleta, `mini` el minimapa.
 */
export const TONE_STYLES: Record<NodeTone, { head: string; bar: string; chip: string; mini: string }> = {
  trigger: { head: "bg-brand-tint text-brand-text", bar: "border-l-brand", chip: "bg-brand-tint text-brand-text", mini: "var(--accent)" },
  condition: { head: "bg-warning-tint text-warning-text", bar: "border-l-warning", chip: "bg-warning-tint text-warning-text", mini: "var(--warning)" },
  wait: { head: "bg-info-tint text-info-text", bar: "border-l-info", chip: "bg-info-tint text-info-text", mini: "var(--info)" },
  message: { head: "bg-success-tint text-success-text", bar: "border-l-success", chip: "bg-success-tint text-success-text", mini: "var(--success)" },
  crm: { head: "bg-subtle text-text-2", bar: "border-l-text-3", chip: "bg-subtle text-text-2", mini: "var(--text-3)" },
};
