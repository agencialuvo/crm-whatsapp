import { KeyRound, ShieldCheck, UserRound, type LucideIcon } from "lucide-react";
import { canConfigure } from "@/lib/auth/roles";
import { ICON_CATALOG, type IconKey } from "@/lib/icon-catalog";
import { applyMenuConfig, type MenuConfig } from "@/lib/menu-config";
import { NAV_ITEM_GROUP, type NavGroupKey, type NavItemKey } from "@/lib/nav-keys";
import type { PlanModule } from "@/lib/plan-modules";

export type { PlanModule };
export type { NavGroupKey, NavItemKey };

/**
 * #87 — El modelo del menú, separado del componente que lo pinta.
 *
 * Qué entradas existen lo deciden dos cosas que el nav de cliente no puede
 * leer solo: las banderas de la instancia (`AGENDA`, `CHANNELS`, `ATRIBUCION`,
 * que bajan por prop desde el servidor) y el rol de quien mira. Tenerlo aquí,
 * sin React, deja que una prueba unitaria afirme qué aparece y qué no sin
 * dibujar nada.
 *
 * Bloque 3 — cada entrada y cada bloque tienen una LLAVE ESTABLE (`nav-keys.ts`) y un icono del catálogo propio
 * (`icon-catalog.ts`). Sobre este menú base, una organización puede reordenar, ocultar y renombrar
 * (`menu-config.ts`, `applyMenuConfig`): jamás agrega entradas ni toca lo que protegen las banderas, el rol o el plan.
 */

export type NavItem = {
  /** Llave estable: la guardan las configuraciones de menú. No cambia aunque cambie la ruta o el nombre. */
  key: NavItemKey;
  href: string;
  label: string;
  icon: LucideIcon;
  /** La llave del icono en el catálogo propio (`ICON_CATALOG`); `icon` es su resultado. */
  iconKey: IconKey;
  /** Muestra el contador de no leídos (solo la Bandeja). */
  badge?: boolean;
  /** Módulo del plan que da acceso a esta entrada; sin él, la entrada es libre. */
  module?: PlanModule;
  /** El plan activo no incluye el módulo: se pinta restringida (insignia «Pro»), no se oculta. */
  locked?: boolean;
};

export type NavGroup = {
  /** Llave estable del bloque. */
  key: NavGroupKey;
  /** Encabezado pequeño; sin él, el grupo es una entrada suelta. */
  title?: string;
  items: NavItem[];
  /** Va al pie de la barra, separado del resto (el grupo «Sistema»). */
  bottom?: boolean;
};

/** Encabezado del bloque donde vive Ajustes, abajo de la barra. */
export const SYSTEM_TITLE = "Sistema";

/** Ajustes, la entrada de configuración del grupo «Sistema». Nunca se oculta (ver `PROTECTED_ITEM_KEYS`). */
export const SETTINGS_ITEM: NavItem = {
  key: "ajustes",
  href: "/ajustes",
  label: "Ajustes",
  icon: ICON_CATALOG.settings,
  iconKey: "settings",
};

type CatalogEntry = { href: string; label: string; iconKey: IconKey; module?: PlanModule; badge?: boolean };

/**
 * El catálogo de entradas: ruta, rótulo de siempre, icono y módulo del plan de cada una. La llave es la estable; el
 * resto puede cambiar sin romper las configuraciones guardadas. El bloque donde nace cada entrada está en
 * `NAV_ITEM_GROUP` (`nav-keys.ts`).
 */
export const NAV_ITEM_CATALOG: Record<NavItemKey, CatalogEntry> = {
  panel: { href: "/panel", label: "Panel", iconKey: "layoutDashboard", module: "finances" },
  bandeja: { href: "/bandeja", label: "Bandeja", iconKey: "inbox", badge: true },
  pipeline: { href: "/pipeline", label: "Pipeline", iconKey: "kanban" },
  caja: { href: "/caja", label: "Caja", iconKey: "wallet", module: "finances" },
  citas: { href: "/citas", label: "Citas", iconKey: "calendarDays", module: "agenda" },
  clientes: { href: "/clientes", label: "Clientes", iconKey: "userCheck", module: "salon" },
  servicios: { href: "/servicios", label: "Servicios", iconKey: "scissors", module: "salon" },
  equipo: { href: "/equipo", label: "Equipo", iconKey: "usersRound", module: "salon" },
  gastos: { href: "/gastos", label: "Gastos", iconKey: "receipt", module: "finances" },
  contactos: { href: "/contactos", label: "Contactos", iconKey: "users" },
  medios: { href: "/medios", label: "Medios", iconKey: "images" },
  automatizaciones: { href: "/automatizaciones", label: "Automatizaciones", iconKey: "zap" },
  guia: { href: "/guia-de-inicio", label: "Guía de inicio", iconKey: "listChecks" },
  agente: { href: "/agente", label: "Agente", iconKey: "sparkles" },
  laboratorio: { href: "/laboratorio", label: "Laboratorio", iconKey: "flaskConical" },
  resultados: { href: "/resultados", label: "Resultados", iconKey: "chartColumn" },
  notificaciones: { href: "/notificaciones", label: "Notificaciones", iconKey: "bell" },
  ajustes: { href: SETTINGS_ITEM.href, label: SETTINGS_ITEM.label, iconKey: "settings" },
};

/** La entrada del catálogo como la usa el menú base. «Ajustes» es siempre la MISMA constante `SETTINGS_ITEM`. */
function navItem(key: NavItemKey): NavItem {
  if (key === "ajustes") return SETTINGS_ITEM;
  const e = NAV_ITEM_CATALOG[key];
  return {
    key,
    href: e.href,
    label: e.label,
    icon: ICON_CATALOG[e.iconKey],
    iconKey: e.iconKey,
    ...(e.badge && { badge: true }),
    ...(e.module && { module: e.module }),
  };
}

/** El título de cada bloque (los que no tienen, son una entrada suelta). */
export const NAV_GROUP_TITLES: Record<NavGroupKey, string | undefined> = {
  trabajo: "Trabajo",
  gestion: "Gestión y equipo",
  agente: "Agente",
  resultados: undefined,
  sistema: SYSTEM_TITLE,
};

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
 *
 * Este es el menú BASE; la personalización de cada organización se aplica después con `applyMenuConfig`.
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
    ...(salonManager ? [navItem("panel")] : []),
    ...(NAV_V2 ? [navItem("bandeja"), navItem("pipeline")] : []),
    ...(salonManager ? [navItem("caja")] : []),
    ...(agenda ? [navItem("citas")] : []),
    ...(salonManager ? [navItem("clientes")] : []),
  ];
  const gestion: NavItem[] = [
    ...(salonManager ? [navItem("servicios"), navItem("equipo"), navItem("gastos")] : []),
    navItem("contactos"),
    navItem("medios"),
    // Configura mensajes automáticos a clientes: solo dueño o administrador, y solo con la bandera.
    ...(automations && canConfigure(role) ? [navItem("automatizaciones")] : []),
  ];
  const sistema: NavItem[] = [navItem("notificaciones"), navItem("ajustes")];
  // Sin entradas, un grupo no se pinta (un miembro del equipo sin agenda no tiene «Trabajo»).
  const groups: NavGroup[] = (
    [
      { key: "trabajo", title: NAV_GROUP_TITLES.trabajo, items: trabajo },
      { key: "gestion", title: NAV_GROUP_TITLES.gestion, items: gestion },
    ] satisfies NavGroup[]
  ).filter((g) => g.items.length > 0);
  if (!NAV_V2) {
    return markLocked([...groups, { key: "sistema", title: SYSTEM_TITLE, items: sistema, bottom: true }], activeModules);
  }

  const agente: NavItem[] = [];
  // Un miembro del equipo no puede hacer ninguno de los pasos de la guía.
  if (canConfigure(role)) {
    agente.push(navItem("guia"));
  }
  agente.push(navItem("agente"), navItem("laboratorio"));
  groups.push({ key: "agente", title: NAV_GROUP_TITLES.agente, items: agente });
  // 019 — Se mide al final: primero se atiende y se organiza.
  groups.push({ key: "resultados", items: [navItem("resultados")] });
  return markLocked([...groups, { key: "sistema", title: SYSTEM_TITLE, items: sistema, bottom: true }], activeModules);
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
 *
 * Con una configuración de menú (`menu`), «visible» es la del menú EFECTIVO: si la organización ocultó esa entrada, se
 * entra a la primera entrada de trabajo que sí se ve (nunca a Notificaciones ni a Ajustes mientras haya otra). La
 * ruta oculta sigue existiendo —ocultar no bloquea nada—, solo deja de ser el destino inicial.
 */
export function salonHomePath({
  agenda = false,
  role,
  menu,
}: {
  agenda?: boolean;
  role?: string | null;
  menu?: MenuConfig | null;
}): string {
  const home = canConfigure(role) ? "/panel" : agenda ? "/citas" : "/contactos";
  if (!menu) return home;
  const visible = applyMenuConfig(appNavGroups({ agenda, salon: true, role }), menu).flatMap((g) => g.items);
  if (visible.some((i) => i.href === home)) return home;
  return (
    visible.find((i) => i.key !== "ajustes" && i.key !== "notificaciones")?.href ??
    visible.find((i) => i.key === "notificaciones")?.href ??
    SETTINGS_ITEM.href
  );
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
  suscripcion = false,
  menu = false,
}: {
  /** Bloque 3 — «Menú» (personalizar el menú lateral) solo para quien puede configurar el negocio. */
  menu?: boolean;
  /** 046 — «Suscripción» existe solo con el cobro con Mercado Pago encendido (`MERCADOPAGO`). */
  suscripcion?: boolean;
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
  if (menu) negocio.push({ href: "/ajustes/menu", label: "Menú" });
  if (suscripcion) negocio.push({ href: "/ajustes/suscripcion", label: "Suscripción" });

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

// `NAV_ITEM_GROUP` se reexporta para quien arma pantallas del menú sin importar dos módulos.
export { NAV_ITEM_GROUP };
