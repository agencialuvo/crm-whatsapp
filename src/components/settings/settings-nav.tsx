"use client";

import { useEffect, useState } from "react";
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
  return (
    <nav
      aria-label="Ajustes"
      className="flex shrink-0 gap-4 overflow-x-auto border-b px-2 py-2 sm:w-48 sm:flex-col sm:gap-5 sm:overflow-visible sm:border-b-0 sm:border-r sm:p-3"
    >
      {sections.map((section) => (
        <div
          key={section.title}
          className="flex shrink-0 items-center gap-1 sm:flex-col sm:items-stretch sm:gap-0.5"
        >
          <span className="kicker mr-1 shrink-0 sm:mb-1 sm:mr-0 sm:px-3">{section.title}</span>
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
                  "block shrink-0 whitespace-nowrap rounded-sm px-3 py-2 text-[13.5px] font-semibold transition-colors",
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
      ))}
    </nav>
  );
}
