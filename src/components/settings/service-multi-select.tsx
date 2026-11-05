"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { money } from "@/lib/salon/format";
import type { ComboDto, ServiceDto } from "@/lib/salon/types";

type Option = { id: string; name: string; priceCents: number };

/**
 * Selector múltiple para Marketing (campaña de cumpleaños, sellos y premios): una lista con casillas y
 * buscador, con los servicios y, aparte, las ofertas (las ofertas también son servicios del negocio). Los
 * ids se guardan juntos en una sola lista. Sin ninguno marcado vale «todos»: así un negocio que no quiere
 * excluir nada no tiene que marcar nada, y uno que sí, marca solo los que entran.
 */
export function ServiceMultiSelect({
  services,
  offers = [],
  value,
  onChange,
  currency,
  disabled = false,
  idPrefix,
  emptyHint = "Sin marcar ninguno, aplica a todos los servicios y ofertas.",
}: {
  services: ServiceDto[];
  offers?: ComboDto[];
  value: string[];
  onChange: (next: string[]) => void;
  currency: string;
  disabled?: boolean;
  idPrefix: string;
  emptyHint?: string;
}) {
  const [q, setQ] = useState("");
  const chosen = useMemo(() => new Set(value), [value]);
  const needle = q.trim().toLowerCase();
  const filter = (list: Option[]) => (needle ? list.filter((s) => s.name.toLowerCase().includes(needle)) : list);
  const shownServices = useMemo(() => filter(services), [services, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownOffers = useMemo(() => filter(offers), [offers, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownCount = shownServices.length + shownOffers.length;

  const toggle = (id: string) => onChange(chosen.has(id) ? value.filter((x) => x !== id) : [...value, id]);
  // Algo marcado que ya no está activo sigue contando hasta que se desmarque a propósito.
  const known = new Set([...services, ...offers].map((s) => s.id));
  const orphans = value.filter((id) => !known.has(id)).length;

  if (services.length + offers.length === 0) {
    return <p className="text-xs text-text-3">Aún no hay servicios ni ofertas activos. Créalos en Servicios.</p>;
  }

  const group = (title: string, list: Option[]) =>
    list.length === 0 ? null : (
      <li key={title}>
        <p className="kicker bg-subtle/60 px-3 py-1.5">{title}</p>
        <ul className="divide-y">
          {list.map((s) => {
            const id = `${idPrefix}-${s.id}`;
            return (
              <li key={s.id}>
                <label htmlFor={id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-row-hover">
                  <input
                    id={id}
                    type="checkbox"
                    checked={chosen.has(s.id)}
                    onChange={() => toggle(s.id)}
                    disabled={disabled}
                    className="accent-primary"
                  />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-text-3">{money(s.priceCents, currency)}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </li>
    );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3" aria-hidden />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar servicio u oferta…"
            aria-label="Buscar servicio u oferta"
            className="pl-8"
            disabled={disabled}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || shownCount === 0}
          onClick={() =>
            onChange([...new Set([...value, ...shownServices.map((s) => s.id), ...shownOffers.map((s) => s.id)])])
          }
        >
          Marcar {needle ? "los que se ven" : "todos"}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={disabled || value.length === 0} onClick={() => onChange([])}>
          Quitar todos
        </Button>
      </div>
      <ul className="max-h-72 divide-y overflow-y-auto rounded-md border bg-card" aria-label="Servicios y ofertas">
        {shownCount === 0 && <li className="px-3 py-2 text-sm text-text-3">Nada coincide con la búsqueda.</li>}
        {group("Servicios", shownServices)}
        {group("Ofertas", shownOffers)}
      </ul>
      <p className="text-xs text-text-3">
        {value.length === 0
          ? emptyHint
          : `${value.length} ${value.length === 1 ? "marcado" : "marcados"}${
              orphans > 0 ? ` (${orphans} ya no ${orphans === 1 ? "está activo" : "están activos"})` : ""
            }.`}
      </p>
    </div>
  );
}
