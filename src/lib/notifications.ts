/**
 * Notificaciones del equipo — contratos compartidos entre cliente y servidor.
 * Módulo puro (sin BD ni React).
 */

export const NOTIFICATION_CATEGORIES = ["cita", "venta", "whatsapp", "sistema"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export type NotificationDto = {
  id: string;
  title: string;
  message: string;
  category: NotificationCategory;
  isRead: boolean;
  /** Ruta interna a la que lleva (la cita, la venta); null si no hay a dónde ir. */
  link: string | null;
  /** Instante UTC (ISO). */
  createdAt: string;
};

/** Los filtros de `/notificaciones`. */
export const NOTIFICATION_FILTERS = ["todas", "no_leidas", "citas", "whatsapp"] as const;
export type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number];

export const NOTIFICATION_FILTER_LABELS: Record<NotificationFilter, string> = {
  todas: "Todas",
  no_leidas: "No leídas",
  citas: "Citas",
  whatsapp: "WhatsApp",
};

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  cita: "Cita",
  venta: "Venta",
  whatsapp: "WhatsApp",
  sistema: "Sistema",
};

/** Qué categoría filtra cada pestaña (`null` = no filtra por categoría). */
export function filterCategory(filter: NotificationFilter): NotificationCategory | null {
  switch (filter) {
    case "citas":
      return "cita";
    case "whatsapp":
      return "whatsapp";
    default:
      return null;
  }
}

export type NotificationListDto = {
  items: NotificationDto[];
  /** Cuántas siguen sin leer (de todas, no solo de la página). */
  unread: number;
  hasMore: boolean;
};

/** "hace un momento", "hace 5 min", "hace 3 h", "hace 2 d" — a partir de un instante ISO. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(iso));
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}
