import {
  Bell,
  CalendarDays,
  ChartColumn,
  FlaskConical,
  Images,
  Inbox,
  Kanban,
  Receipt,
  LayoutDashboard,
  ListChecks,
  Scissors,
  UserCheck,
  Settings,
  Sparkles,
  Users,
  UsersRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { canConfigure } from "@/lib/auth/roles";

/**
 * #87 — El modelo del menú, separado del componente que lo pinta.
 *
 * Qué entradas existen lo deciden dos cosas que el nav de cliente no puede
 * leer solo: las banderas de la instancia (`AGENDA`, `CHANNELS`, `ATRIBUCION`,
 * que bajan por prop desde el servidor) y el rol de quien mira. Tenerlo aquí,
 * sin React, deja que una prueba unitaria afirme qué aparece y qué no sin
 * dibujar nada.
 */

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Muestra el contador de no leídos (solo la Bandeja). */
  badge?: boolean;
};

export type NavGroup = {
  /** Encabezado pequeño; sin él, el grupo es una entrada suelta. */
  title?: string;
  items: NavItem[];
};

/** La única entrada que va abajo, separada del resto. */
export const SETTINGS_ITEM: NavItem = {
  href: "/ajustes",
  label: "Ajustes",
  icon: Settings,
};

/** Encabezado del bloque donde vive Ajustes, abajo de la barra. */
export const SYSTEM_TITLE = "Sistema";

/**
 * Hoja de ruta v2.0: Bandeja, Pipeline y el bloque Agente (Guía de inicio,
 * Agente, Laboratorio y Resultados) siguen existiendo —sus rutas funcionan—,
 * pero la v1.0 enfoca la barra en la operación del salón o barbería. Poner en
 * `true` los devuelve al menú, sin tocar nada más.
 */
export const NAV_V2 = false;

/**
 * Grupos de la barra lateral, en el orden en que se leen. En la v1.0 es uno:
 * Trabajo (Panel · Caja · Citas · Clientes · Contactos · Servicios · Equipo ·
 * Medios); Ajustes va aparte, abajo, bajo «Sistema».
 */
export function appNavGroups({
  agenda = false,
  salon = false,
  role,
}: {
  /** 015 — "Citas" solo existe si esta instancia encendió la agenda. */
  agenda?: boolean;
  /** Módulo SALON — Panel, Caja, Servicios, Equipo y Clientes (la agenda por sillas vive dentro de Citas). */
  salon?: boolean;
  /** #86 — La guía de inicio solo para quien puede configurar. */
  role?: string | null;
}): NavGroup[] {
  // SALON — barbería o salón. Un miembro del equipo no ve el panel, la caja,
  // el catálogo, el equipo ni los clientes (es dinero y configuración).
  const salonManager = salon && canConfigure(role);
  // La agenda por sillas no es un ítem aparte: es la vista principal de Citas
  // (con su calendario y bloqueos en otra pestaña).
  const trabajo: NavItem[] = [
    ...(salonManager ? [{ href: "/panel", label: "Panel", icon: LayoutDashboard }] : []),
    ...(NAV_V2
      ? [
          { href: "/bandeja", label: "Bandeja", icon: Inbox, badge: true },
          { href: "/pipeline", label: "Pipeline", icon: Kanban },
        ]
      : []),
    ...(salonManager
      ? [
          { href: "/caja", label: "Caja", icon: Wallet },
          { href: "/gastos", label: "Gastos", icon: Receipt },
        ]
      : []),
    ...(agenda ? [{ href: "/citas", label: "Citas", icon: CalendarDays }] : []),
    ...(salonManager ? [{ href: "/clientes", label: "Clientes", icon: UserCheck }] : []),
    { href: "/contactos", label: "Contactos", icon: Users },
    ...(salonManager
      ? [
          { href: "/servicios", label: "Servicios", icon: Scissors },
          { href: "/equipo", label: "Equipo", icon: UsersRound },
        ]
      : []),
    { href: "/medios", label: "Medios", icon: Images },
    { href: "/notificaciones", label: "Notificaciones", icon: Bell },
  ];
  const groups: NavGroup[] = [{ title: "Trabajo", items: trabajo }];
  if (!NAV_V2) return groups;

  const agente: NavItem[] = [];
  // Un miembro del equipo no puede hacer ninguno de los pasos de la guía.
  if (canConfigure(role)) {
    agente.push({ href: "/guia-de-inicio", label: "Guía de inicio", icon: ListChecks });
  }
  agente.push(
    { href: "/agente", label: "Agente", icon: Sparkles },
    { href: "/laboratorio", label: "Laboratorio", icon: FlaskConical }
  );
  groups.push({ title: "Agente", items: agente });
  // 019 — Se mide al final: primero se atiende y se organiza.
  groups.push({ items: [{ href: "/resultados", label: "Resultados", icon: ChartColumn }] });
  return groups;
}

/**
 * A dónde se entra al abrir la raíz o iniciar sesión con el módulo SALON
 * encendido: el Panel, para quien lo ve (dueño o administrador); un miembro del
 * equipo, que no tiene Panel, va a lo primero de su menú (Citas o Contactos).
 * Siempre es una entrada visible del menú, así queda marcada como activa.
 */
export function salonHomePath({
  agenda = false,
  role,
}: {
  agenda?: boolean;
  role?: string | null;
}): string {
  if (canConfigure(role)) return "/panel";
  return agenda ? "/citas" : "/contactos";
}

export type SettingsLink = { href: string; label: string };

export type SettingsSection = {
  title: string;
  links: SettingsLink[];
};

/**
 * Ajustes en tres secciones: por dónde entran los mensajes, qué hace el agente
 * con ellos y lo que es del negocio. Una pestaña por canal no escala; una
 * sección por canal, sí: cada canal nuevo cae en "Canales" sin tocar el resto.
 *
 * Instagram no tiene pantalla propia todavía: sus credenciales se guardan
 * por API (`/api/settings/instagram`). Cuando la tenga, va aquí tras
 * `CHANNELS`, igual que Messenger.
 */
export function settingsSections({
  agenda = false,
  atribucion = false,
  instagram = false,
  messenger = false,
  tiktok = false,
  salon = false,
}: {
  /** 031 — "Fidelización" existe solo con la bandera SALON. */
  salon?: boolean;
  agenda?: boolean;
  /** 016 — "Anuncios" existe solo con la bandera ATRIBUCION. */
  atribucion?: boolean;
  /** 023 — "Instagram" solo si el canal está encendido con CHANNELS. */
  instagram?: boolean;
  /** 017 — "Messenger", igual. */
  messenger?: boolean;
  /** 022 — "TikTok", igual: solo con el canal en CHANNELS. */
  tiktok?: boolean;
}): SettingsSection[] {
  const canales: SettingsLink[] = [];
  // 023 — "Estado" reúne todos los canales; con WhatsApp solo no aporta nada
  // que su pantalla no diga, así que no existe (ADR-001).
  if (instagram || messenger || tiktok) {
    canales.push({ href: "/ajustes/canales", label: "Estado" });
  }
  canales.push({ href: "/ajustes/whatsapp", label: "WhatsApp" });
  if (instagram) canales.push({ href: "/ajustes/instagram", label: "Instagram" });
  if (messenger) canales.push({ href: "/ajustes/messenger", label: "Messenger" });
  if (tiktok) canales.push({ href: "/ajustes/tiktok", label: "TikTok" });

  // #85 — el proveedor de IA se configura aquí; el entorno queda de respaldo.
  const agente: SettingsLink[] = [{ href: "/ajustes/ia", label: "IA" }];
  if (agenda) agente.push({ href: "/ajustes/calendario", label: "Agenda" });

  const negocio: SettingsLink[] = [
    { href: "/ajustes/marca", label: "Marca" },
    { href: "/ajustes/plantillas", label: "Plantillas" },
    { href: "/ajustes/equipo", label: "Equipo" },
  ];
  if (atribucion) negocio.push({ href: "/ajustes/anuncios", label: "Anuncios" });
  if (salon) negocio.push({ href: "/ajustes/fidelizacion", label: "Fidelización" });

  return [
    { title: "Canales", links: canales },
    { title: "Agente", links: agente },
    { title: "Negocio", links: negocio },
  ];
}

/** Activa si la ruta es la entrada o cuelga de ella (`/bandeja/cv_123`). */
export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
