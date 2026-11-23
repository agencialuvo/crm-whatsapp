"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronUp, Lock, LogOut, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import type { Branding } from "@/lib/branding";
import { cn, initials } from "@/lib/utils";
import {
  ACCOUNT_MENU_LINKS,
  appNavGroups,
  isNavActive,
  type NavItem,
} from "@/lib/nav";
import { signOut } from "@/lib/auth/client";
import { applyMenuConfig, type MenuConfig } from "@/lib/menu-config";
import { goToSettingsAnchor } from "@/lib/settings-scroll";
import { useEvents } from "@/components/use-events";
import { BrandLogo, BrandTile } from "@/components/brand-mark";
import { ConfirmDialog, Modal } from "@/components/negocio/modal";
import { useOrganizationContext } from "@/hooks/use-organization-context";

/**
 * Un renglón del menú, como el `side-item` del mockup de la landing: texto
 * semibold, esquinas de 9px y, activo, lavado del acento con tinta azul.
 * Exportado para la vista previa de Configuración → Marca, que pinta la barra.
 */
export function navItemClass(active: boolean, collapsed = false) {
  return cn(
    "group relative flex items-center gap-[10px] rounded-sm px-2.5 py-2.5 text-[13.5px] font-semibold transition-colors lg:py-2",
    // Riel contraído (solo escritorio): el icono queda centrado.
    collapsed && "lg:justify-center lg:gap-0 lg:px-0",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active
      ? "bg-brand text-brand-fg"
      : "text-text-2 hover:bg-accent hover:text-foreground",
  );
}

export function AppNav({
  branding,
  userName,
  userImage = null,
  role,
  agenda = false,
  salon = false,
  automations = false,
  menuConfig = null,
  open = false,
  onClose,
  collapsed = false,
  onToggleCollapsed,
}: {
  branding: Branding;
  userName: string;
  userImage?: string | null;
  role: string;
  /**
   * 015 — ¿hay agenda en esta instancia? Viene del servidor por prop y no se
   * deduce de los datos: una instancia con la agenda encendida pero sin citas
   * todavía debe ver la entrada igual.
   */
  agenda?: boolean;
  /** Módulo SALON: lo decide el servidor, igual que `agenda`. */
  salon?: boolean;
  /** Automatizaciones: lo decide el servidor (`AUTOMATIONS`), igual que `agenda`. */
  automations?: boolean;
  /**
   * El menú personalizado de la organización, ya resuelto por el servidor (sin parpadeo). Solo cambia visibilidad,
   * orden, nombres e iconos de lo que el menú base ya trae: nunca agrega entradas ni abre rutas.
   */
  menuConfig?: MenuConfig | null;
  /** Solo aplica por debajo de `lg`: en escritorio el lateral es fijo. */
  open?: boolean;
  onClose?: () => void;
  /** Solo escritorio: riel de iconos. En móvil el cajón siempre sale completo. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [unread, setUnread] = useState(0);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Entrada bloqueada por el plan sobre la que se pulsó: abre la invitación a mejorar.
  const [upsell, setUpsell] = useState<NavItem | null>(null);
  const { context } = useOrganizationContext();
  const menuRef = useRef<HTMLDivElement>(null);
  // Tooltip del riel contraído: fijo y fuera del <aside> (que recorta lo que sobresale).
  const [tip, setTip] = useState<{ label: string; y: number } | null>(null);
  const showTip = (label: string) => (e: React.SyntheticEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ label, y: r.top + r.height / 2 });
  };
  const hideTip = () => setTip(null);
  const c = collapsed;
  // Al expandir o navegar no debe quedar un tooltip colgado.
  useEffect(() => setTip(null), [collapsed, pathname]);

  // El menú del usuario se cierra al navegar, con Escape y al tocar fuera.
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  /**
   * 042 — El número de «Bandeja» sale de un `SUM` en el servidor, no de descargar la lista de conversaciones
   * (esta barra vive en TODAS las pantallas y en todas las pestañas). Los avisos que llegan juntos se agrupan
   * en un solo viaje, y solo cambian el número los eventos que de verdad lo mueven: un mensaje ENTRANTE, una
   * conversación leída o una eliminada. Un saliente o una etapa que cambia no lo tocan.
   */
  const unreadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unreadSeq = useRef(0);

  async function refetchUnread() {
    const mine = ++unreadSeq.current;
    const res = await fetch("/api/conversations/unread").catch(() => null);
    if (!res?.ok || mine !== unreadSeq.current) return; // una respuesta vieja no pisa a una nueva
    const data = (await res.json()) as { unread: number };
    setUnread(data.unread);
  }

  function scheduleUnread() {
    if (unreadTimer.current) clearTimeout(unreadTimer.current);
    unreadTimer.current = setTimeout(() => void refetchUnread(), 400);
  }

  useEffect(() => {
    void refetchUnread();
    return () => {
      if (unreadTimer.current) clearTimeout(unreadTimer.current);
    };
  }, []);

  useEvents({
    onMessageNew: ({ message }) => {
      if ((message as { direction?: string } | null)?.direction === "in") scheduleUnread();
    },
    onConversationRead: () => scheduleUnread(),
    onConversationDeleted: () => scheduleUnread(),
    onReconnect: () => scheduleUnread(),
  });

  // #87 — Qué hay en el menú y en qué grupo lo decide `appNavGroups`; aquí
  // solo se pinta. Los módulos del plan llegan por el contexto de la organización;
  // mientras carga (o si falla) no hay datos del plan y nada se bloquea.
  const allGroups = applyMenuConfig(
    appNavGroups({
      agenda,
      salon,
      automations,
      role,
      activeModules: context?.plan.features.modules,
    }),
    menuConfig
  );
  const groups = allGroups.filter((g) => !g.bottom);
  const bottomGroup = allGroups.find((g) => g.bottom);

  function renderItem(item: NavItem) {
    // El plan no incluye este módulo: se ve, atenuado y con «Pro», pero no navega.
    if (item.locked) {
      return (
        <button
          key={item.href}
          type="button"
          onClick={() => setUpsell(item)}
          title={c ? `${item.label} · no incluido en tu plan` : "No incluido en tu plan"}
          onMouseEnter={c ? showTip(item.label) : undefined}
          onMouseLeave={hideTip}
          onFocus={c ? showTip(item.label) : undefined}
          onBlur={hideTip}
          className={cn(navItemClass(false, c), "w-full text-left opacity-60 hover:opacity-100")}
        >
          <item.icon className="h-5 w-5 shrink-0 text-text-3" strokeWidth={1.8} aria-hidden />
          <span className={cn("flex-1", c && "lg:sr-only")}>{item.label}</span>
          <span className={cn("flex items-center gap-1 rounded-full bg-brand-soft px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-text", c && "lg:hidden")}>
            <Lock className="h-2.5 w-2.5" strokeWidth={2.2} aria-hidden />
            Pro
          </span>
          {c && <Lock className="absolute right-2 top-1.5 hidden h-2.5 w-2.5 text-text-3 lg:block" strokeWidth={2.4} aria-hidden />}
          <span className="sr-only">: no incluido en tu plan</span>
        </button>
      );
    }
    const active = isNavActive(pathname, item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        className={navItemClass(active, c)}
        aria-current={active ? "page" : undefined}
        title={c ? item.label : undefined}
        onMouseEnter={c ? showTip(item.label) : undefined}
        onMouseLeave={hideTip}
        onFocus={c ? showTip(item.label) : undefined}
        onBlur={hideTip}
      >
        <item.icon
          className={cn(
            "h-5 w-5 shrink-0 transition-colors",
            active
              ? "text-brand-fg"
              : "text-text-3 group-hover:text-foreground",
          )}
          strokeWidth={1.8}
          aria-hidden
        />
        <span className={cn("flex-1", c && "lg:sr-only")}>{item.label}</span>
        {item.badge && unread > 0 && (
          <span
            className={cn(
              "flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-1.5 text-[10.5px] font-bold text-brand-fg",
              c && "lg:hidden"
            )}
          >
            {unread}
          </span>
        )}
        {c && item.badge && unread > 0 && (
          <span
            aria-hidden
            className={cn(
              "absolute right-2 top-1.5 hidden h-2.5 w-2.5 rounded-full ring-2 lg:block",
              active ? "bg-brand-fg ring-brand" : "bg-brand ring-subtle"
            )}
          />
        )}
      </Link>
    );
  }

  return (
    <>
      <aside
        // Móvil: cajón que se desliza desde la izquierda (siempre montado, así
        // la transición corre en ambos sentidos). Escritorio: columna fija.
        // `visibility` va en la transición a propósito: al cerrar mantiene el
        // cajón visible mientras se desliza y recién entonces lo oculta, que es
        // lo que lo saca del orden de tabulación en móvil.
        className={cn(
          // `text-foreground` explícito: el texto sin color propio hereda el de `.nav-panel`.
          "nav-panel fixed inset-y-0 left-0 z-50 flex w-[17rem] shrink-0 flex-col overflow-y-auto overflow-x-hidden [scrollbar-width:thin] border-r bg-subtle px-3 pb-3.5 pt-4 text-foreground transition-[transform,visibility,width] duration-200",
          // `lg:transform-none`: sin transform el menú de cuenta (fixed) se ancla al viewport y no al panel.
          "lg:static lg:visible lg:z-auto lg:transform-none",
          c ? "lg:w-16 lg:px-2" : "lg:w-56",
          open
            ? "visible translate-x-0 shadow-pop"
            : "invisible -translate-x-full",
        )}
      >
        {/* Marca: el logo de Vocero o, white-label, la inicial y el nombre */}
        <div className={cn("mb-5 flex items-start gap-1.5 px-2 pt-0.5", c && "lg:mb-3 lg:flex-col lg:items-center lg:px-0")}>
          {/* En móvil el cajón necesita su propio cierre: el velo no siempre es
            alcanzable con el pulgar. */}
          <button
            onClick={onClose}
            aria-label="Cerrar el menú"
            className="-ml-1 mt-0.5 rounded-md p-1.5 text-text-3 hover:bg-accent hover:text-foreground lg:hidden"
          >
            <X className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </button>
          {/* El nombre de marca baja a una segunda línea en vez de cortarse con «…» */}
          <div className={cn("min-w-0 flex-1 [&_.truncate]:overflow-visible [&_.truncate]:whitespace-normal [&_.truncate]:leading-[1.1]", c && "lg:hidden")}>
            <BrandLogo branding={branding} />
          </div>
          {/* Contraído: solo el isotipo, centrado */}
          {c && (
            <span className="hidden lg:flex">
              <BrandTile branding={branding} className="h-[30px] w-[30px] rounded-[9px] text-[15px]" />
            </span>
          )}
          {onToggleCollapsed && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label={c ? "Expandir el menú lateral" : "Contraer el menú lateral"}
              aria-expanded={!c}
              title={`${c ? "Expandir" : "Contraer"} el menú (Ctrl+B)`}
              className="mt-0.5 hidden rounded-md p-1.5 text-text-3 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:block"
            >
              {c ? (
                <PanelLeftOpen className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden />
              ) : (
                <PanelLeftClose className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden />
              )}
            </button>
          )}
        </div>

        {/* Grupos con encabezado pequeño, sin letras ni colapsables: se leen
          de arriba abajo como una lista de lo que hay. Una sección sin título
          (o con el título vacío) no pinta encabezado: queda separada por el espacio. */}
        <nav className="flex flex-col gap-4" aria-label="Secciones">
          {groups.map((group) => (
            <div key={group.key} className={cn("flex flex-col gap-0.5", c && "lg:border-t lg:pt-3 lg:first:border-t-0 lg:first:pt-0")}>
              {group.title?.trim() && (
                <span className={cn("kicker mb-1 block px-2.5", c && "lg:hidden")} aria-hidden>
                  {group.title}
                </span>
              )}
              {group.items.map(renderItem)}
            </div>
          ))}
        </nav>

        <div className="flex-1" />

        {/* «Sistema» (Notificaciones y Ajustes) va al pie: no es trabajo del día. */}
        {bottomGroup && (
          <div className={cn("mt-3 flex flex-col gap-0.5", c && "lg:border-t lg:pt-3")}>
            {bottomGroup.title?.trim() && (
              <span className={cn("kicker mb-1 block px-2.5", c && "lg:hidden")} aria-hidden>
                {bottomGroup.title}
              </span>
            )}
            {bottomGroup.items.map(renderItem)}
          </div>
        )}

        {/* Tarjeta del usuario: abre un menú hacia arriba con «Mi perfil» y «Cerrar sesión». */}
        <div ref={menuRef} className="relative mt-1">
          {menuOpen && (
            <div
              role="menu"
              aria-label="Cuenta"
              className={cn(
                "absolute inset-x-0 bottom-full z-10 mb-1 rounded-md border bg-popover p-1 shadow-pop",
                // Contraído: flota a un lado del avatar (no cabe en el riel).
                c && "lg:fixed lg:inset-x-auto lg:bottom-3 lg:left-[4.5rem] lg:mb-0 lg:w-56"
              )}
            >
              {ACCOUNT_MENU_LINKS.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  role="menuitem"
                  onClick={(e) => {
                    // Ya en Mi perfil: se desplaza ahí mismo (el `#ancla` nativo movía todo el marco).
                    if (pathname.startsWith("/ajustes/perfil")) {
                      e.preventDefault();
                      setMenuOpen(false);
                      goToSettingsAnchor(item.href);
                    }
                  }}
                  className="flex items-center gap-2.5 rounded-sm px-2.5 py-2 text-[13.5px] font-semibold text-text-2 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <item.icon className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden />
                  {item.label}
                </Link>
              ))}
              <div role="separator" className="-mx-1 my-1 border-t" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmingSignOut(true);
                }}
                className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left text-[13.5px] font-semibold text-danger-text transition-colors hover:bg-danger-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <LogOut className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden />
                Cerrar sesión
              </button>
            </div>
          )}
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            title={c ? userName : undefined}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              c && "lg:justify-center lg:px-0"
            )}
          >
            {userImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={userImage} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-bold text-brand-text">
                {initials(userName)}
              </span>
            )}
            <span className={cn("min-w-0 flex-1", c && "lg:sr-only")}>
              <span className="block truncate text-[13px] font-semibold">{userName}</span>
              <span className="block truncate text-[11px] text-text-3">
                {role === "owner" ? "Propietario" : "Equipo"} · En línea
              </span>
            </span>
            <ChevronUp
              className={cn("h-4 w-4 shrink-0 text-text-3 transition-transform", !menuOpen && "rotate-180", c && "lg:hidden")}
              strokeWidth={1.8}
              aria-hidden
            />
          </button>
        </div>
      </aside>
      {c && tip && (
        <span
          role="tooltip"
          style={{ top: tip.y }}
          className="pointer-events-none fixed left-[4.25rem] z-[60] hidden -translate-y-1/2 whitespace-nowrap rounded-md bg-foreground px-2.5 py-1.5 text-xs font-semibold text-background shadow-pop lg:block"
        >
          {tip.label}
        </span>
      )}
      {upsell && (
        <Modal
          title={`${upsell.label} no está en tu plan`}
          description={`Tu plan${context ? ` ${context.plan.name}` : ""} no incluye este módulo.`}
          onClose={() => setUpsell(null)}
          size="sm"
        >
          <p className="text-sm text-text-2">
            {role === "owner" || role === "admin"
              ? "Mejora tu plan para activarlo: las pantallas y los datos del módulo quedarán disponibles al instante."
              : "Pídele al propietario o a un administrador que mejore el plan para activarlo."}
          </p>
        </Modal>
      )}
      {confirmingSignOut && (
        <ConfirmDialog
          title="Cerrar sesión"
          message="¿Seguro que quieres cerrar sesión?"
          confirmLabel="Cerrar sesión"
          onClose={() => setConfirmingSignOut(false)}
          onConfirm={async () => {
            await signOut();
            router.push("/iniciar-sesion");
            router.refresh();
          }}
        />
      )}
    </>
  );
}
