"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Cake, LifeBuoy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/search-select";
import { DataTablePagination, DataTableToolbar } from "@/components/ui/data-table-pagination";
import { SearchInput } from "@/components/ui/search-input";
import { useDataTable } from "@/components/ui/use-data-table";
import { apiFetch, describeError } from "@/components/negocio/api";
import { KpiCard } from "@/components/negocio/dashboard-widgets";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { Section } from "@/components/results/section";
import {
  BIRTHDAY_FILTERS,
  BIRTHDAY_FILTER_LABEL,
  BIRTHDAY_STATUS_LABEL,
  RESCUE_BLOCK_LABEL,
  countByFilter,
  filterBirthdays,
  type BirthdayFilter,
  type BirthdayStatus,
  type RescueBlock,
  type RescueState,
} from "@/lib/salon/birthday-campaign";
import { MONTH_NAMES, money } from "@/lib/salon/format";
import type { BirthdayClientDto, SalonDashboardDto } from "@/lib/salon/types";
import { cn } from "@/lib/utils";

const NONE: never[] = [];
const BIRTHDAY_NOUN = { one: "cumpleaños", other: "cumpleaños" };

const STATUS_BADGE: Record<BirthdayStatus, "success" | "default" | "secondary" | "warning" | "destructive"> = {
  aprovecho: "success",
  agendado: "default",
  enviado: "secondary",
  fallido: "destructive",
  sin_enviar: "warning",
};

/** Enlace de WhatsApp con un texto listo; solo con un celular de dígitos. */
function whatsappLink(phone: string | null, text: string): string | null {
  if (!phone || !/^\d{7,15}$/.test(phone)) return null;
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

const firstName = (name: string) => name.split(" ")[0] ?? "";
const greetingText = (name: string) => `¡Hola ${firstName(name)}! 🎉 Feliz cumpleaños de parte de todo el equipo.`;
const inviteText = (name: string) =>
  `¡Hola ${firstName(name)}! 🎂 ¿Te reservamos tu cita de cumpleaños? Este mes es especial para ti: dinos qué día te queda mejor.`;

const pct = (n: number | null) => (n === null ? "—" : `${n}%`);

const RESCUE_STATE_LABEL: Record<RescueState, string> = {
  pending: "Rescate en cola",
  delivered: "Rescate enviado",
  failed: "Rescate fallido",
};

/** La respuesta de `POST /api/negocio/cumpleanos/rescate`. */
type RescueLaunchResponse = {
  period: string;
  attempted: number;
  enqueued: number;
  skipped: { contactId: string; reason: RescueBlock | "not_birthday" | "error" }[];
  remaining: number;
};

/**
 * Panel → Cumpleaños del mes: KPIs de la campaña (cumpleañeros, contactados, agendados y quiénes aprovecharon),
 * desglose por automatización de cumpleaños, y la lista con buscador, filtros rápidos y el estado de cada cliente.
 * Las reglas de cada estado están en `lib/salon/birthday-campaign.ts`.
 */
export function BirthdaysSection({
  birthdays,
  currency,
  loading,
  hasData,
  onChanged,
}: {
  birthdays: SalonDashboardDto["birthdays"] | undefined;
  currency: string;
  loading: boolean;
  hasData: boolean;
  /** Algo cambió en el servidor (se lanzó el rescate): el Panel vuelve a pedir los datos. */
  onChanged?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<BirthdayFilter>("todos");
  // Saludos manuales marcados en esta sesión (o quitados): el Panel no se recarga por un clic.
  const [manualOverride, setManualOverride] = useState<Record<string, boolean>>({});
  const [greetError, setGreetError] = useState<string | null>(null);

  const clients = useMemo(
    () => (birthdays?.clients ?? NONE).map((c) => applyManual(c, manualOverride[c.id])),
    [birthdays, manualOverride]
  );
  const counts = useMemo(() => countByFilter(clients), [clients]);
  const filtered = useMemo(() => filterBirthdays(clients, { filter, query }), [clients, filter, query]);
  const table = useDataTable(filtered, {
    view: "panel-cumpleanos",
    defaultPageSize: 10,
    resetKey: `${filter}|${query}`,
  });
  const k = birthdays?.kpis;
  const monthName = birthdays ? MONTH_NAMES[birthdays.month - 1] : null;

  async function markGreeted(c: BirthdayClientDto, greeted: boolean) {
    setGreetError(null);
    setManualOverride((m) => ({ ...m, [c.id]: greeted }));
    try {
      await apiFetch("/api/negocio/cumpleanos/saludo", {
        method: greeted ? "POST" : "DELETE",
        json: { contactId: c.id },
        keepalive: true,
      });
    } catch (err) {
      // Sin registro, la fila vuelve a lo que decía el servidor: nunca se muestra un saludo que no quedó guardado.
      setManualOverride((m) => {
        const next = { ...m };
        delete next[c.id];
        return next;
      });
      setGreetError(`No se pudo registrar el saludo de ${c.name}: ${describeError(err)}`);
    }
  }

  return (
    <Section
      title={monthName ? `Cumpleaños de ${monthName}` : "Cumpleaños del mes"}
      hint="Quién cumple este mes, a quién ya se saludó y quién aprovechó (se atendió o compró en su mes de cumpleaños)."
      loading={loading && !hasData}
      hasData={hasData}
      empty={birthdays?.clients.length === 0}
      emptyText="Ningún cliente cumple años este mes. Registra el cumpleaños al cobrar o desde Clientes."
    >
      {birthdays && k && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard label="Cumpleañeros del mes" value={String(k.total)} />
            <KpiCard
              label="Contactados"
              value={String(k.contacted)}
              hint={`${k.contactedAuto} automático · ${k.contactedManual} a mano · ${k.notSent + k.failed} sin enviar o fallidos`}
            />
            <KpiCard label="Agendados" value={String(k.booked)} hint="Con cita reservada en su mes" />
            <KpiCard
              label="Aprovecharon"
              value={String(k.converted)}
              hint={`${pct(k.conversionRate)} de los contactados · ${money(k.revenueCents, currency)} cobrados`}
            />
          </div>

          {birthdays.flows.length > 0 && <FlowBreakdown flows={birthdays.flows} currency={currency} />}

          <RescuePanel
            rescue={birthdays.rescue}
            currency={currency}
            onLaunched={() => {
              setFilter("todos");
              onChanged?.();
            }}
          />

          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Buscar por nombre o teléfono"
              ariaLabel="Buscar cumpleañeros"
              className="w-full sm:w-64"
              maxLength={80}
            />
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar por estado">
              {BIRTHDAY_FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    filter === f ? "border-brand bg-brand-tint text-brand-text" : "text-text-2 hover:bg-accent hover:text-foreground"
                  )}
                >
                  {BIRTHDAY_FILTER_LABEL[f]} <span className="tabular-nums text-text-3">{counts[f]}</span>
                </button>
              ))}
            </div>
          </div>

          {greetError && (
            <p role="alert" className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text">
              {greetError}
            </p>
          )}

          <DataTableToolbar {...table.pagination} noun={BIRTHDAY_NOUN} />
          {filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-3">Nadie coincide con la búsqueda o el filtro.</p>
          ) : (
            <ul className="divide-y">
              {table.rows.map((c) => (
                <BirthdayRow
                  key={c.id}
                  c={c}
                  today={birthdays.today}
                  currency={currency}
                  onGreet={() => void markGreeted(c, true)}
                  onUngreet={() => void markGreeted(c, false)}
                />
              ))}
            </ul>
          )}
          <DataTablePagination {...table.pagination} noun={BIRTHDAY_NOUN} label="Paginación de cumpleaños" />
        </div>
      )}
    </Section>
  );
}

/** El saludo manual marcado o quitado en pantalla, con el estado recalculado (sin esperar al servidor). */
function applyManual(c: BirthdayClientDto, manual: boolean | undefined): BirthdayClientDto {
  if (manual === undefined) return c;
  const auto = c.contactedBy === "auto" || c.contactedBy === "both";
  const contactedBy = auto && manual ? "both" : auto ? "auto" : manual ? "manual" : null;
  const status: BirthdayStatus =
    c.status === "aprovecho" || c.status === "agendado"
      ? c.status
      : contactedBy
        ? "enviado"
        : c.sendFailed
          ? "fallido"
          : "sin_enviar";
  return { ...c, contactedBy, status };
}

function BirthdayRow({
  c,
  today,
  currency,
  onGreet,
  onUngreet,
}: {
  c: BirthdayClientDto;
  today: number;
  currency: string;
  onGreet: () => void;
  onUngreet: () => void;
}) {
  const isToday = c.day === today;
  const passed = c.day < today;
  const action = rowAction(c);
  const detail =
    c.status === "aprovecho"
      ? `${money(c.windowRevenueCents, currency)} este mes`
      : c.contactedBy === "manual"
        ? "Saludado a mano"
        : c.contactedBy === "both"
          ? "Saludo automático y a mano"
          : c.contactedBy === "auto"
            ? "Saludo automático"
            : null;
  return (
    <li className="flex flex-wrap items-center gap-3 py-2 sm:flex-nowrap">
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-md border text-sm font-bold tabular-nums",
          isToday ? "border-brand bg-brand-tint text-brand-text" : passed ? "text-text-3" : "bg-subtle"
        )}
      >
        {c.day}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {c.name}
          {isToday && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-text">
              <Cake className="h-3.5 w-3.5" aria-hidden />
              ¡Hoy!
            </span>
          )}
        </p>
        <p className="truncate text-xs text-text-3">
          {c.visits} visita{c.visits === 1 ? "" : "s"} · {money(c.totalCents, currency)} invertidos
          {detail ? ` · ${detail}` : ""}
          {c.sendFailed && c.status !== "fallido" ? " · un envío automático falló" : ""}
        </p>
      </div>
      <Badge variant={STATUS_BADGE[c.status]} className="shrink-0" data-estado={c.status}>
        {BIRTHDAY_STATUS_LABEL[c.status]}
      </Badge>
      {c.rescue && (
        <Badge
          variant={c.rescue === "failed" ? "destructive" : "outline"}
          className="shrink-0"
          data-rescate={c.rescue}
        >
          {RESCUE_STATE_LABEL[c.rescue]}
        </Badge>
      )}
      {action.kind === "link" && (
        <a
          href={action.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={action.registers ? onGreet : undefined}
          className={ACTION_CLASS}
          aria-label={`${action.label} a ${c.name} por WhatsApp`}
        >
          {action.label}
        </a>
      )}
      {action.kind === "mark" && (
        <button type="button" onClick={onGreet} className={ACTION_CLASS} aria-label={`Marcar a ${c.name} como saludado`}>
          Marcar saludado
        </button>
      )}
      {action.kind === "bookings" && (
        <Link href="/citas" className={ACTION_CLASS}>
          Ver citas
        </Link>
      )}
      {c.contactedBy === "manual" && c.status === "enviado" && (
        <button
          type="button"
          onClick={onUngreet}
          className="shrink-0 text-xs text-text-3 underline-offset-2 hover:underline"
          aria-label={`Quitar el saludo manual de ${c.name}`}
        >
          Quitar
        </button>
      )}
    </li>
  );
}

const ACTION_CLASS =
  "shrink-0 rounded-md border px-2.5 py-1.5 text-xs font-semibold text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

type RowAction =
  | { kind: "link"; href: string; label: string; registers: boolean }
  | { kind: "mark" }
  | { kind: "bookings" }
  | { kind: "none" };

/**
 * La acción de cada estado: sin saludo → «Saludar» (abre WhatsApp y registra el saludo manual; sin celular,
 * «Marcar saludado»); saludado sin cita → «Invitar» a reservar; agendado → «Ver citas»; aprovechó → nada.
 */
export function rowAction(c: Pick<BirthdayClientDto, "status" | "phone" | "name">): RowAction {
  switch (c.status) {
    case "sin_enviar":
    case "fallido": {
      const href = whatsappLink(c.phone, greetingText(c.name));
      return href ? { kind: "link", href, label: "Saludar", registers: true } : { kind: "mark" };
    }
    case "enviado": {
      const href = whatsappLink(c.phone, inviteText(c.name));
      return href ? { kind: "link", href, label: "Invitar", registers: false } : { kind: "none" };
    }
    case "agendado":
      return { kind: "bookings" };
    case "aprovecho":
      return { kind: "none" };
  }
}

function FlowBreakdown({ flows, currency }: { flows: SalonDashboardDto["birthdays"]["flows"]; currency: string }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[560px] text-sm">
        <caption className="sr-only">Resultados por automatización de cumpleaños</caption>
        <thead className="bg-subtle text-xs text-text-3">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">Automatización</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Enviados</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Fallidos</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Agendados</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Aprovecharon</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Conversión</th>
          </tr>
        </thead>
        <tbody className="divide-y tabular-nums">
          {flows.map((f) => (
            <tr key={f.id}>
              <td className="px-3 py-2">
                <Link href={`/automatizaciones/${f.id}`} className="font-medium hover:underline">
                  {f.name}
                </Link>
                {!f.active && <span className="ml-2 text-xs text-text-3">(apagada)</span>}
              </td>
              <td className="px-3 py-2 text-right">{f.sent}</td>
              <td className={cn("px-3 py-2 text-right", f.failed > 0 && "text-danger-text")}>{f.failed}</td>
              <td className="px-3 py-2 text-right">{f.booked}</td>
              <td className="px-3 py-2 text-right">
                {f.converted}
                {f.revenueCents > 0 && <span className="ml-1 text-xs text-text-3">({money(f.revenueCents, currency)})</span>}
              </td>
              <td className="px-3 py-2 text-right font-semibold">{pct(f.conversionRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SKIP_LABEL: Record<RescueLaunchResponse["skipped"][number]["reason"], string> = {
  ...RESCUE_BLOCK_LABEL,
  not_birthday: "No cumple años este mes",
  error: "No se pudo encolar (se puede reintentar)",
};

/** Resumen legible de un lanzamiento: cuántos salieron a la cola y por qué quedaron fuera los demás. */
export function describeRescueResult(r: RescueLaunchResponse): string {
  const parts = [`${r.enqueued} rescate${r.enqueued === 1 ? "" : "s"} en cola`];
  const byReason = new Map<string, number>();
  for (const s of r.skipped) byReason.set(SKIP_LABEL[s.reason], (byReason.get(SKIP_LABEL[s.reason]) ?? 0) + 1);
  for (const [label, n] of byReason) parts.push(`${n} omitido${n === 1 ? "" : "s"}: ${label.toLowerCase()}`);
  if (r.remaining > 0) parts.push(`quedan ${r.remaining} por lanzar (vuelve a enviarlo)`);
  return parts.join(" · ");
}

/**
 * Paso 3 — «Rescate de última oportunidad»: a los cumpleañeros del mes que no reservaron ni aprovecharon se les
 * manda, UNA vez en el mes, un flujo manual del negocio. Muestra el alcance antes de enviar y el resultado después.
 */
function RescuePanel({
  rescue,
  currency,
  onLaunched,
}: {
  rescue: SalonDashboardDto["birthdays"]["rescue"];
  currency: string;
  onLaunched: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [flowId, setFlowId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  if (!rescue.available) return null;
  const noFlows = rescue.flows.length === 0;
  const daysText =
    rescue.daysLeft === 0 ? "Hoy es el último día del mes" : `Quedan ${rescue.daysLeft} día${rescue.daysLeft === 1 ? "" : "s"} del mes`;
  const excluded = rescue.excluded.opted_out + rescue.excluded.no_conversation;

  async function launch() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<RescueLaunchResponse>("/api/negocio/cumpleanos/rescate", {
        method: "POST",
        json: { flowId },
      });
      setResult(describeRescueResult(r));
      setOpen(false);
      onLaunched();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn("rounded-md border p-3", rescue.suggested && rescue.eligible > 0 && "border-warning-soft bg-warning-tint")}
      data-rescate-panel
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <LifeBuoy className="h-4 w-4" aria-hidden />
            Rescate de última oportunidad
          </p>
          <p className="text-xs text-text-2">
            {daysText}. {rescue.eligible} cumpleañero{rescue.eligible === 1 ? "" : "s"} sin cita ni compra
            {rescue.eligible === 1 ? " puede" : " pueden"} recibirlo (una sola vez en el mes).
            {excluded > 0 &&
              ` Quedan fuera ${rescue.excluded.opted_out} por baja y ${rescue.excluded.no_conversation} sin chat de WhatsApp.`}
          </p>
          {rescue.launched > 0 && (
            <p className="text-xs text-text-2" data-rescate-resultado>
              Lanzados {rescue.launched}: {rescue.delivered} enviados · {rescue.pending} en cola · {rescue.failed} fallidos ·{" "}
              {rescue.booked} reservaron · {rescue.converted} aprovecharon ({pct(rescue.conversionRate)} de los enviados
              {rescue.revenueCents > 0 ? `, ${money(rescue.revenueCents, currency)}` : ""})
            </p>
          )}
          {result && (
            <p role="status" className="text-xs font-medium text-success-text">
              {result}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant={rescue.suggested ? "default" : "outline"}
          disabled={rescue.eligible === 0}
          onClick={() => {
            setError(null);
            setFlowId(rescue.flows[0]?.id ?? "");
            setOpen(true);
          }}
        >
          {rescue.eligible === 0 ? "Nadie por rescatar" : `Enviar rescate a ${rescue.eligible}`}
        </Button>
      </div>

      {open && (
        <Modal
          title="Rescate de última oportunidad"
          description={`Se enviará a ${rescue.eligible} cumpleañero${rescue.eligible === 1 ? "" : "s"} que no reservaron ni aprovecharon este mes. Nadie lo recibe dos veces en el mes.`}
          onClose={() => setOpen(false)}
          busy={busy}
          size="sm"
        >
          {noFlows ? (
            <p className="text-sm text-text-2">
              Primero crea y enciende un flujo con disparador «Manual» con el mensaje del rescate (fuera de las 24 h de
              WhatsApp, usa una plantilla aprobada) en{" "}
              <Link href="/automatizaciones" className="font-medium text-primary hover:underline">
                Automatizaciones
              </Link>
              .
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium">Flujo con que se envía</p>
              <SearchSelect
                value={flowId}
                onChange={setFlowId}
                options={rescue.flows.map((f) => ({ value: f.id, label: f.name }))}
                placeholder="Elige un flujo manual"
                searchPlaceholder="Buscar flujo…"
                ariaLabel="Flujo del rescate"
              />
              <p className="text-xs text-text-3">
                Sale por el motor de automatizaciones: respeta las bajas, el tope de mensajes y la ventana de 24 h. Lo que
                no se pueda entregar se verá como «Rescate fallido».
              </p>
            </div>
          )}
          <ModalFooter error={error}>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={() => void launch()} disabled={busy || noFlows || !flowId}>
              {busy ? "Enviando…" : `Enviar a ${rescue.eligible}`}
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
}
