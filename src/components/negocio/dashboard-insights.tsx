"use client";

import { Section } from "@/components/results/section";
import { MIN_CYCLE_INTERVALS, type RepurchaseDto, type TicketSideDto, type TicketSplitDto } from "@/lib/salon/insights";
import { money } from "@/lib/salon/format";
import { cn } from "@/lib/utils";

/**
 * Panel — métricas de negocio: el ticket de los servicios sueltos contra el de las ofertas, y cada
 * cuántos días vuelve un cliente. Las cuentas son de `src/lib/salon/insights.ts`; aquí solo se pintan.
 */

const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

/* ------------------------------ servicios vs ofertas ------------------------------ */

function TicketSide({
  label,
  side,
  max,
  tone,
  currency,
}: {
  label: string;
  side: TicketSideDto;
  max: number;
  tone: string;
  currency: string;
}) {
  const width = side.avgCents && max > 0 ? Math.max(4, Math.round((side.avgCents / max) * 100)) : 0;
  return (
    <div className="min-w-0 rounded-md border bg-subtle px-3 py-2.5">
      <p className="text-xs font-medium text-text-2">{label}</p>
      <p className="mt-0.5 truncate text-xl font-semibold tabular-nums">
        {side.avgCents === null ? "—" : money(side.avgCents, currency)}
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border" aria-hidden>
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${width}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-text-3">
        {side.count === 0
          ? "sin ventas en el periodo"
          : `${plural(side.count, "venta", "ventas")} · ${money(side.revenueCents, currency)}`}
      </p>
    </div>
  );
}

export function TicketSplitCard({
  split,
  currency,
  loading,
}: {
  split: TicketSplitDto | null;
  currency: string;
  loading: boolean;
}) {
  const total = split ? split.services.count + split.offers.count : 0;
  const max = split ? Math.max(split.services.avgCents ?? 0, split.offers.avgCents ?? 0) : 0;

  let verdict: { text: string; tone: string } | null = null;
  if (split) {
    if (split.liftCents === null || split.liftPercent === null) {
      verdict = {
        text:
          total === 0
            ? "Sin ventas en este periodo."
            : "Para comparar hacen falta ventas con oferta y ventas de servicios sueltos en el periodo.",
        tone: "text-text-3",
      };
    } else if (split.liftCents > 0) {
      verdict = {
        text: `Cada visita con oferta deja ${money(split.liftCents, currency)} más (+${split.liftPercent} %) que un servicio suelto: las ofertas sí elevan el ticket.`,
        tone: "text-success-text",
      };
    } else if (split.liftCents < 0) {
      verdict = {
        text: `Cada visita con oferta deja ${money(-split.liftCents, currency)} menos (${split.liftPercent} %) que un servicio suelto: revisa si el descuento se compensa con el volumen.`,
        tone: "text-warning-text",
      };
    } else {
      verdict = { text: "Las ofertas y los servicios sueltos dejan el mismo ticket.", tone: "text-text-3" };
    }
  }

  return (
    <Section
      title="Ticket promedio: servicios vs. ofertas"
      hint="Lo que deja cada visita según lleve o no una oferta."
      loading={loading}
      hasData={split !== null}
    >
      {split && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <TicketSide label="Servicios sueltos" side={split.services} max={max} tone="bg-brand-soft" currency={currency} />
            <TicketSide label="Ofertas" side={split.offers} max={max} tone="bg-brand" currency={currency} />
          </div>
          {total > 0 && (
            <p className="text-xs text-text-3">
              Las ofertas son el {Math.round((split.offers.count / total) * 100)} % de las {total} ventas del periodo.
            </p>
          )}
          {verdict && <p className={cn("text-sm font-medium", verdict.tone)}>{verdict.text}</p>}
        </div>
      )}
    </Section>
  );
}

/* ------------------------------ ciclo de recompra ------------------------------ */

const daysLabel = (n: number) => `${n % 1 === 0 ? n : n.toFixed(1)} ${n === 1 ? "día" : "días"}`;

/** Enlace de WhatsApp para recordarle su próxima visita; solo con un celular de dígitos. */
function reminderLink(phone: string | null, name: string): string | null {
  if (!phone || !/^\d{7,15}$/.test(phone)) return null;
  const text = `¡Hola ${name.split(" ")[0] ?? ""}! Hace un tiempo que no te vemos por aquí. ¿Te agendamos tu próxima visita?`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

function Counter({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="min-w-0 rounded-md border bg-subtle px-3 py-2">
      <p className="text-xs font-medium text-text-2">{label}</p>
      <p className={cn("mt-0.5 text-lg font-semibold tabular-nums", tone)}>{value}</p>
    </div>
  );
}

export function RepurchaseCard({ cycle, loading }: { cycle: RepurchaseDto | null; loading: boolean }) {
  const has = cycle !== null && cycle.avgDays !== null && cycle.medianDays !== null;

  return (
    <Section
      title="Ciclo de recompra"
      hint="Cada cuántos días vuelve un cliente, con todo su historial."
      loading={loading}
      hasData={cycle !== null}
      empty={cycle !== null && !has}
      emptyText="Todavía no hay clientes con 2 o más visitas para medir su ciclo. Cobra con el cliente identificado para empezar."
    >
      {cycle && has && (
        <div className="space-y-3">
          <div>
            <p className="text-2xl font-semibold tabular-nums">Cada {daysLabel(cycle.avgDays!)}</p>
            <p className="mt-0.5 text-xs text-text-3">
              promedio · lo típico (mediana) es {daysLabel(cycle.medianDays!)} · {plural(cycle.clients, "cliente", "clientes")} con
              2 o más visitas ({plural(cycle.intervals, "intervalo", "intervalos")})
            </p>
          </div>

          {!cycle.reliable ? (
            <p className="rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
              Aún hay pocos datos: con al menos {MIN_CYCLE_INTERVALS} intervalos entre visitas el ciclo es fiable y empiezan los
              avisos de a quién recordarle.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2.5">
                <Counter label="Por vencer" value={cycle.reminders.soon} />
                <Counter label="Ya les toca" value={cycle.reminders.due} tone="text-warning-text" />
                <Counter label="Perdidos" value={cycle.reminders.lost} tone="text-danger-text" />
              </div>
              <p className="text-[11px] text-text-3">
                «Por vencer»: ya están al 80 % de su ciclo · «Ya les toca»: pasaron su ciclo · «Perdidos»: pasaron el doble.
              </p>

              {cycle.reminders.list.length > 0 && (
                <ul className="divide-y" aria-label="Clientes a quienes recordarles">
                  {cycle.reminders.list.map((c) => {
                    const link = reminderLink(c.phone, c.name);
                    return (
                      <li key={c.id} className="flex items-center gap-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{c.name}</p>
                          <p className="truncate text-xs text-text-3">
                            hace {daysLabel(c.daysSince)} · {c.status === "due" ? "ya le toca volver" : "le toca pronto"}
                          </p>
                        </div>
                        {link && (
                          <a
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 rounded-md border px-2.5 py-1.5 text-xs font-semibold text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={`Recordarle a ${c.name} por WhatsApp`}
                          >
                            Recordar
                          </a>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </Section>
  );
}
