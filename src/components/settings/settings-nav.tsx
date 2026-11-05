"use client";

import { useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { settingsSections } from "@/lib/nav";
import { goToSettingsAnchor } from "@/lib/settings-scroll";

/**
 * #87 — Ajustes en tres secciones (Canales, Agente, Negocio). Qué enlaces
 * existen lo decide el servidor y baja por prop: este es un componente de
 * cliente y no puede leer variables de entorno.
 *
 * Desde `sm` cada sección es un desplegable (un encabezado con su flecha): se abre sola la
 * que contiene la pantalla actual y las demás quedan cerradas, para que la lista no sea una
 * pared de enlaces. Se pueden abrir varias a la vez.
 *
 * Por debajo de `sm` las secciones van en una fila que se desplaza, cada una
 * con su encabezado delante de sus enlaces, para que en el teléfono siga
 * siendo una tira de pestañas navegable y no una columna que empuje el
 * contenido abajo.
 */
export function SettingsNav({
  agenda = false,
  atribucion = false,
  instagram = false,
  messenger = false,
  tiktok = false,
  salon = false,
}: {
  salon?: boolean;
  agenda?: boolean;
  atribucion?: boolean;
  instagram?: boolean;
  messenger?: boolean;
  tiktok?: boolean;
}) {
  const pathname = usePathname();
  const sections = settingsSections({ agenda, atribucion, instagram, messenger, tiktok, salon });
  // Los enlaces con ancla (`/ajustes/perfil#seguridad`) comparten pantalla: cuál está
  // activo lo dice el `#` de la dirección, que Next no avisa al navegar con pushState.
  const [hash, setHash] = useState("");
  useEffect(() => {
    const read = () => setHash(window.location.hash);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [pathname]);
  const allLinks = sections.flatMap((s) => s.links);
  const baseId = useId();
  // Títulos de las secciones abiertas a mano; la de la pantalla actual siempre queda abierta.
  const [opened, setOpened] = useState<string[]>([]);
  const isActive = (href: string) => {
    const [path = "", anchor] = href.split("#");
    if (!pathname.startsWith(path)) return false;
    if (!anchor) return true;
    if (hash === `#${anchor}`) return true;
    // Sin ancla en la dirección, queda marcada la primera zona de la pantalla.
    const first = allLinks.find((l) => l.href.split("#")[0] === path);
    // Una zona que no tiene enlace aquí (la del menú del usuario) deja marcada la primera.
    const known = allLinks.some((l) => l.href === `${path}${hash}`);
    return first?.href === href && !known;
  };
  const toggle = (title: string) =>
    setOpened((cur) => (cur.includes(title) ? cur.filter((t) => t !== title) : [...cur, title]));
  return (
    <nav
      aria-label="Ajustes"
      className="flex shrink-0 gap-4 overflow-x-auto border-b px-2 py-2 sm:w-56 sm:flex-col sm:gap-5 sm:overflow-x-hidden sm:overflow-y-auto sm:border-b-0 sm:border-r sm:p-3"
    >
      {sections.map((section, idx) => {
        const hasActive = section.links.some((l) => isActive(l.href));
        const open = hasActive || opened.includes(section.title);
        const panelId = `${baseId}-${idx}`;
        return (
          <div
            key={section.title}
            className="flex shrink-0 items-center gap-1 sm:flex-col sm:items-stretch sm:gap-0.5"
          >
            {/* En móvil es solo el rótulo de la tira; desde `sm` es el botón del desplegable. */}
            <button
              type="button"
              onClick={() => toggle(section.title)}
              aria-expanded={open}
              aria-controls={panelId}
              // Con la pantalla actual dentro, no se puede cerrar: quedaría el menú sin «dónde estoy».
              disabled={hasActive}
              className={cn(
                "kicker mr-1 flex shrink-0 items-center justify-between gap-2 rounded-sm text-left max-sm:pointer-events-none",
                "sm:mb-0 sm:mr-0 sm:px-3 sm:py-2 sm:hover:bg-accent sm:disabled:cursor-default sm:disabled:hover:bg-transparent",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              )}
            >
              <span>{section.title}</span>
              <ChevronDown
                aria-hidden
                className={cn(
                  "hidden h-3.5 w-3.5 shrink-0 text-text-3 transition-transform sm:block",
                  open && "rotate-180"
                )}
              />
            </button>
            <div
              id={panelId}
              // Cerrado se oculta solo desde `sm`: en móvil la tira siempre muestra todos los enlaces.
              className={cn(
                "flex items-center gap-1 sm:flex-col sm:items-stretch sm:gap-0.5",
                !open && "sm:hidden"
              )}
            >
              {section.links.map((t) => {
                const active = isActive(t.href);
                return (
                  <Link
                    key={t.href}
                    href={t.href}
                    onClick={(e) => {
                      const [path = "", anchor] = t.href.split("#");
                      if (!anchor) return;
                      // En la misma pantalla se desplaza a mano (ver `scrollToSettingsAnchor`).
                      if (pathname.startsWith(path)) {
                        e.preventDefault();
                        goToSettingsAnchor(t.href);
                      } else {
                        setHash(`#${anchor}`);
                      }
                    }}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block shrink-0 whitespace-nowrap rounded-sm px-3 py-2 text-[13.5px] font-semibold transition-colors sm:ml-2",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "bg-brand-tint text-brand-text"
                        : "text-text-2 hover:bg-accent hover:text-foreground"
                    )}
                  >
                    {t.label}
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}
