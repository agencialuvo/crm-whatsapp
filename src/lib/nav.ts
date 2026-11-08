import {
  Bell,
  CalendarDays,
  ChartColumn,
  FlaskConical,
  Images,
  Inbox,
  Kanban,
  KeyRound,
  ShieldCheck,
  UserRound,
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
  Zap,
  type LucideIcon,
} from "lucide-react";
import { canConfigure } from "@/lib/auth/roles";
import type { PlanModule } from "@/lib/plan-modules";

export type { PlanModule };

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
  /** Módulo del plan que da acceso a esta entrada; sin él, la entrada es libre. */
  module?: PlanModule;
  /** El plan activo no incluye el módulo: se pinta restringida (insignia «Pro»), no se oculta. */
  locked?: boolean;
};

export type NavGroup = {
  /** Encabezado pequeño; sin él, el grupo es una entrada suelta. */
  title?: string;
  items: NavItem[];
  /** Va al pie de la barra, separado del resto (el grupo «Sistema»). */
  bottom?: boolean;
};

/** Ajustes, la entrada de configuración del grupo «Sistema». */
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
 * `true` los devuelve al menú, sin tocar nada más. Se enciende sin tocar código con
 * `NEXT_PUBLIC_NAV_V2=on` (se lee al construir y al arrancar el servidor de desarrollo).
 */
export const NAV_V2 = process.env.NEXT_PUBLIC_NAV_V2 === "on";

/**
 * Grupos de la barra lateral, en el orden en que se leen. En la v1.0 son tres:
 * Trabajo (Panel · Caja · Citas · Clientes), Gestión y equipo (Servicios ·
 * Equipo · Gastos · Contactos · Medios) y Sistema (Notificaciones · Ajustes),
 * este último al pie de la barra.
 */
export function appNavGroups({
  agenda = false,
  salon = false,
  automations = false,
  role,
  activeModules,
}: {
  /**
   * Módulos que incluye el plan de la organización. Las entradas de un módulo que
   * NO esté en la lista salen con `locked` (llamada a mejorar el plan) en vez de
   * desaparecer. `undefined` = sin datos del plan (cargando, o sin plan): nada se
   * restringe. Ojo: esto no sustituye a las banderas de despliegue ni al rol, que
   * siguen decidiendo si la entrada EXISTE; el plan solo decide si está bloqueada.
   */
  activeModules?: readonly string[];
  /** 015 — "Citas" solo existe si esta instancia encendió la agenda. */
  agenda?: boolean;
  /** Módulo SALON — Panel, Caja, Servicios, Equipo y Clientes (la agenda por sillas vive dentro de Citas). */
  salon?: boolean;
  /** Automatizaciones: mensajes y esperas programados. Solo existe si la instancia lo enciende (`AUTOMATIONS`). */
  automations?: boolean;
  /** #86 — La guía de inicio solo para quien puede configurar. */
  role?: string | null;
}): NavGroup[] {
  // SALON — barbería o salón. Un miembro del equipo no ve el panel, la caja,
  // el catálogo, el equipo ni los clientes (es dinero y configuración).
  const salonManager = salon && canConfigure(role);
  // La agenda por sillas no es un ítem aparte: es la vista principal de Citas
  // (con su calendario y bloqueos en otra pestaña).
  const trabajo: NavItem[] = [
    ...(salonManager ? [{ href: "/panel", label: "Panel", icon: LayoutDashboard, module: "finances" as const }] : []),
    ...(NAV_V2
      ? [
          { href: "/bandeja", label: "Bandeja", icon: Inbox, badge: true },
          { href: "/pipeline", label: "Pipeline", icon: Kanban },
        ]
      : []),
    ...(salonManager ? [{ href: "/caja", label: "Caja", icon: Wallet, module: "finances" as const }] : []),
    ...(agenda ? [{ href: "/citas", label: "Citas", icon: CalendarDays, module: "agenda" as const }] : []),
    ...(salonManager ? [{ href: "/clientes", label: "Clientes", icon: UserCheck, module: "salon" as const }] : []),
  ];
  const gestion: NavItem[] = [
    ...(salonManager
      ? [
          { href: "/servicios", label: "Servicios", icon: Scissors, module: "salon" as const },
          { href: "/equipo", label: "Equipo", icon: UsersRound, module: "salon" as const },
          { href: "/gastos", label: "Gastos", icon: Receipt, module: "finances" as const },
        ]
      : []),
    { href: "/contactos", label: "Contactos", icon: Users },
    { href: "/medios", label: "Medios", icon: Images },
    // Configura mensajes automáticos a clientes: solo dueño o administrador, y solo con la bandera.
    ...(automations && canConfigure(role)
      ? [{ href: "/automatizaciones", label: "Automatizaciones", icon: Zap }]
      : []),
  ];
  const sistema: NavItem[] = [
    { href: "/notificaciones", label: "Notificaciones", icon: Bell },
    SETTINGS_ITEM,
  ];
  // Sin entradas, un grupo no se pinta (un miembro del equipo sin agenda no tiene «Trabajo»).
  const groups: NavGroup[] = [
    { title: "Trabajo", items: trabajo },
    { title: "Gestión y equipo", items: gestion },
  ].filter((g) => g.items.length > 0);
  if (!NAV_V2) {
    return markLocked([...groups, { title: SYSTEM_TITLE, items: sistema, bottom: true }], activeModules);
  }

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
  return markLocked([...groups, { title: SYSTEM_TITLE, items: sistema, bottom: true }], activeModules);
}

/** Marca como `locked` las entradas cuyo módulo no incluye el plan. Sin datos del plan, no toca nada. */
function markLocked(groups: NavGroup[], activeModules: readonly string[] | undefined): NavGroup[] {
  if (!activeModules) return groups;
  return groups.map((g) => ({
    ...g,
    items: g.items.map((item) =>
      item.module && !activeModules.includes(item.module) ? { ...item, locked: true } : item
    ),
  }));
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
  sector = false,
}: {
  /** «Tipo de negocio» existe solo si la organización tiene perfil de sector (módulo SaaS). */
  sector?: boolean;
  /** 031 — «Marketing» (campaña de cumpleaños y tarjeta de fidelización) existe solo con la bandera SALON. */
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
  if (sector) negocio.push({ href: "/ajustes/sector", label: "Tipo de negocio" });

  // Marketing (retención y recompra): solo con el módulo del salón, igual que la fidelización que ya tenía.
  const marketing: SettingsLink[] = salon
    ? [
        { href: "/ajustes/cumpleanos", label: "Campaña de cumpleaños" },
        { href: "/ajustes/fidelizacion", label: "Tarjeta de fidelización" },
      ]
    : [];

  return [
    { title: "Canales", links: canales },
    { title: "Agente", links: agente },
    { title: "Negocio", links: negocio },
    ...(marketing.length > 0 ? [{ title: "Marketing", links: marketing }] : []),
    // Lo personal de quien inició sesión, no de la organización: lo ve cualquier rol.
    {
      title: "Cuenta",
      // Una sola pantalla con tres zonas: cada enlace lleva a la suya (ancla `#…`).
      links: [
        { href: "/ajustes/perfil#perfil", label: "Mi perfil" },
        { href: "/ajustes/perfil#seguridad", label: "Seguridad" },
        { href: "/ajustes/perfil#cambiar-contrasena", label: "Cambiar contraseña" },
      ],
    },
  ];
}

/**
 * El menú del usuario (abajo en la barra lateral): las tres zonas de la pantalla Mi perfil,
 * cada una con su ancla `#…`, y debajo «Cerrar sesión».
 */
export const ACCOUNT_MENU_LINKS = [
  { href: "/ajustes/perfil#perfil", label: "Mi perfil", icon: UserRound },
  { href: "/ajustes/perfil#seguridad", label: "Seguridad", icon: ShieldCheck },
  { href: "/ajustes/perfil#cambiar-contrasena", label: "Cambiar contraseña", icon: KeyRound },
] as const;

/** Activa si la ruta es la entrada o cuelga de ella (`/bandeja/cv_123`). */
export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
