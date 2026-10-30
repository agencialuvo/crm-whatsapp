"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronUp, LogOut, X } from "lucide-react";
import type { Branding } from "@/lib/branding";
import { cn, initials } from "@/lib/utils";
import {
  ACCOUNT_MENU_LINKS,
  appNavGroups,
  isNavActive,
  type NavItem,
} from "@/lib/nav";
import { signOut } from "@/lib/auth/client";
import { goToSettingsAnchor } from "@/lib/settings-scroll";
import { useEvents } from "@/components/use-events";
import { BrandLogo } from "@/components/brand-mark";
import { ConfirmDialog } from "@/components/negocio/modal";

/**
 * Un renglón del menú, como el `side-item` del mockup de la landing: texto
 * semibold, esquinas de 9px y, activo, lavado del acento con tinta azul.
 * Exportado para la vista previa de Configuración → Marca, que pinta la barra.
 */
export function navItemClass(active: boolean) {
  return cn(
    "group flex items-center gap-[10px] rounded-sm px-2.5 py-2.5 text-[13.5px] font-semibold transition-colors lg:py-2",
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
  open = false,
  onClose,
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
  /** Solo aplica por debajo de `lg`: en escritorio el lateral es fijo. */
  open?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [unread, setUnread] = useState(0);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  async function refetchUnread() {
    const res = await fetch("/api/conversations").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as {
      conversations: { unreadCount: number }[];
    };
    setUnread(data.conversations.reduce((a, c) => a + c.unreadCount, 0));
  }

  useEffect(() => {
    void refetchUnread();
  }, []);

  useEvents({
    onMessageNew: () => void refetchUnread(),
    onConversationUpdated: () => void refetchUnread(),
  });

  // #87 — Qué hay en el menú y en qué grupo lo decide `appNavGroups`; aquí
  // solo se pinta.
  const allGroups = appNavGroups({ agenda, salon, role });
  const groups = allGroups.filter((g) => !g.bottom);
  const bottomGroup = allGroups.find((g) => g.bottom);

  function renderItem(item: NavItem) {
    const active = isNavActive(pathname, item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        className={navItemClass(active)}
        aria-current={active ? "page" : undefined}
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
        <span className="flex-1">{item.label}</span>
        {item.badge && unread > 0 && (
          <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-1.5 text-[10.5px] font-bold text-brand-fg">
            {unread}
          </span>
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
          "nav-panel fixed inset-y-0 left-0 z-50 flex w-[17rem] shrink-0 flex-col overflow-y-auto overflow-x-hidden [scrollbar-width:thin] border-r bg-subtle px-3 pb-3.5 pt-4 text-foreground transition-[transform,visibility] duration-200",
          "lg:static lg:visible lg:z-auto lg:w-56 lg:translate-x-0 lg:transition-none",
          open
            ? "visible translate-x-0 shadow-pop"
            : "invisible -translate-x-full",
        )}
      >
        {/* Marca: el logo de Vocero o, white-label, la inicial y el nombre */}
        <div className="mb-5 flex items-start gap-1.5 px-2 pt-0.5">
          {/* En móvil el cajón necesita su propio cierre: el velo no siempre es
            alcanzable con el pulgar. */}
          <button
            onClick={onClose}
            aria-label="Cerrar el menú"
            className="-ml-1 mt-0.5 rounded-md p-1.5 text-text-3 hover:bg-accent hover:text-foreground lg:hidden"
          >
            <X className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </button>
          <div className="min-w-0">
            <BrandLogo branding={branding} />
          </div>
        </div>

        {/* Grupos con encabezado pequeño, sin letras ni colapsables: se leen
          de arriba abajo como una lista de lo que hay. Un grupo sin título
          (Resultados) es una entrada suelta separada por el espacio. */}
        <nav className="flex flex-col gap-4" aria-label="Secciones">
          {groups.map((group, i) => (
            <div key={group.title ?? i} className="flex flex-col gap-0.5">
              {group.title && (
                <span className="kicker mb-1 block px-2.5" aria-hidden>
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
          <div className="mt-3 flex flex-col gap-0.5">
            <span className="kicker mb-1 block px-2.5" aria-hidden>
              {bottomGroup.title}
            </span>
            {bottomGroup.items.map(renderItem)}
          </div>
        )}

        {/* Tarjeta del usuario: abre un menú hacia arriba con «Mi perfil» y «Cerrar sesión». */}
        <div ref={menuRef} className="relative mt-1">
          {menuOpen && (
            <div
              role="menu"
              aria-label="Cuenta"
              className="absolute inset-x-0 bottom-full z-10 mb-1 rounded-md border bg-popover p-1 shadow-pop"
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
            className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {userImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={userImage} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-bold text-brand-text">
                {initials(userName)}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold">{userName}</span>
              <span className="block truncate text-[11px] text-text-3">
                {role === "owner" ? "Propietario" : "Equipo"} · En línea
              </span>
            </span>
            <ChevronUp
              className={cn("h-4 w-4 shrink-0 text-text-3 transition-transform", !menuOpen && "rotate-180")}
              strokeWidth={1.8}
              aria-hidden
            />
          </button>
        </div>
      </aside>
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
