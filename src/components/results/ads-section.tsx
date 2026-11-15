"use client";

import type { ReactNode } from "react";
import {
  rate,
  type AdGroupBy,
  type AdGroupRowDto,
  type AdRowDto,
  type AdsBlockDto,
  type AdsHierarchyDto,
  type AdStatus,
  type AdTotalDto,
  type GroupStatus,
  type RateDto,
  type SpendDto,
} from "@/lib/analytics";
import {
  crumbs,
  drillInto,
  goToLevel,
  pickAdset,
  pickCampaign,
  SIN_IDENTIFICAR,
  tieneFiltros,
  VISTA_INICIAL,
  type AdsView,
} from "@/lib/ads-nav";
import { Badge } from "@/components/ui/badge";
import { etiquetaDeOrigen, titularDeOrigen } from "@/lib/anuncios";
import { cn } from "@/lib/utils";
import { MiniaturaDeAnuncio } from "@/components/anuncio-origen";
import { SearchSelect } from "@/components/ui/search-select";
import { Section, Subhead } from "./section";
import { RateCard, StatCard } from "./stat-card";

type Conteos = { conversations: number; leads: number; won: number; winRate: RateDto };

/**
 * 019 — De dónde llegan: por origen y por anuncio.
 * 038 — Con la Marketing API conectada: por campaña, conjunto o anuncio, con gasto y costo.
 *
 * Sin credenciales (o sin la bandera) la sección es la de 019: conteos y nada más.
 * Con ellas, un costo vacío es «—» —falta el gasto o el denominador es 0—, nunca un 0
 * que parezca dato.
 *
 * En el teléfono cada fila es una tarjeta con sus números a la vista: una tabla
 * de ocho columnas ahí esconde justo los números detrás de un scroll lateral.
 */
export function AdsSection({
  data,
  loading,
  error,
  view = VISTA_INICIAL,
  onViewChange,
}: {
  data: AdsBlockDto | null;
  loading: boolean;
  error: string | null;
  view?: AdsView;
  onViewChange?: (next: AdsView) => void;
}) {
  const h = data?.hierarchy ?? null;
  // Columnas de gasto: solo si el conector trae algo que enseñar y la moneda no es una mezcla.
  const conGasto = !!h && (h.connected || h.hasData) && !h.mixedCurrency;
  const conCitas = !!data?.ads.some((a) => a.bookings !== null && a.bookings !== undefined);
  const moneda = h?.currency ?? null;
  const agrupado = !!data && data.groupBy !== undefined && data.groupBy !== "ad";

  return (
    <Section
      id="origen"
      title="Origen y anuncios"
      hint="Por dónde llegan las conversaciones y qué anuncio trae gente que compra."
      loading={loading}
      error={error}
      hasData={!!data}
      empty={!!data?.empty}
      emptyText="No empezó ninguna conversación en este periodo."
    >
      {data && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:max-w-xl">
            <StatCard
              label="Conversaciones nuevas"
              value={String(data.conversations.current)}
              compare={data.conversations}
            />
            <RateCard
              label="Llegaron por un anuncio"
              rate={data.adShare}
              unit="conversaciones"
            />
          </div>

          <div>
            <Subhead>Por origen</Subhead>
            <Filas
              primera="Origen"
              conGasto={false}
              conCitas={false}
              moneda={null}
              filas={data.sources.map((s) => ({
                key: s.value,
                titulo: <span className="font-medium">{s.label}</span>,
                conteos: s,
              }))}
            />
          </div>

          <div>
            <Subhead>{agrupado ? (data.groupBy === "campaign" ? "Por campaña" : "Por conjunto de anuncios") : "Por anuncio"}</Subhead>

            {h && <Estado hierarchy={h} />}
            {h && (h.connected || h.hasData) && onViewChange && (
              <Controles data={data} view={view} onChange={onViewChange} />
            )}
            {h && (h.connected || h.hasData) && onViewChange && <Migas data={data} view={view} onChange={onViewChange} />}

            {agrupado ? (
              data.groups && data.groups.length > 0 ? (
                <Filas
                  primera={data.groupBy === "campaign" ? "Campaña" : "Conjunto"}
                  conGasto={conGasto}
                  conCitas={conCitas}
                  moneda={moneda}
                  total={conGasto ? data.total : undefined}
                  filas={data.groups.map((g) => ({
                    key: g.key,
                    titulo: (
                      <Grupo
                        grupo={g}
                        onAbrir={
                          onViewChange
                            ? () => onViewChange(drillInto(view, { key: g.key, level: g.level === "campaign" ? "campaign" : "adset", campaignId: g.campaignId }))
                            : undefined
                        }
                      />
                    ),
                    conteos: g,
                    bookings: g.bookings,
                    costs: g,
                  }))}
                />
              ) : (
                <SinCoincidencia view={view} onViewChange={onViewChange} texto="Nada coincide con este filtro en el periodo." />
              )
            ) : data.ads.length === 0 ? (
              tieneFiltros(view) ? (
                <SinCoincidencia view={view} onViewChange={onViewChange} texto="Nada coincide con este filtro en el periodo." />
              ) : (
                <p className="text-sm text-text-3">Ninguna conversación de este periodo llegó por un anuncio de Click a WhatsApp.</p>
              )
            ) : (
              <Filas
                primera="Anuncio"
                conGasto={conGasto}
                conCitas={conCitas}
                moneda={moneda}
                total={conGasto ? data.total : undefined}
                filas={data.ads.map((a) => ({
                  key: a.key,
                  titulo: <Anuncio anuncio={a} />,
                  conteos: a,
                  sourceId: a.sourceId,
                  bookings: a.bookings ?? null,
                  costs: a,
                }))}
              />
            )}
          </div>

          {h && conGasto && <Cuenta hierarchy={h} total={data.total} filtrado={tieneFiltros(view)} moneda={moneda} />}

          <div className="space-y-1 text-[11px] text-text-3">
            <p>
              «Ventas» son los prospectos del periodo que hoy están en Ganado; «Cierre» es
              ventas entre prospectos, atenuado con menos de 10 (muestra chica).
            </p>
            {conGasto ? (
              <p>
                El gasto viene de tu cuenta publicitaria de Meta. Cada costo es el gasto entre los
                resultados del periodo (conversaciones, prospectos o citas agendadas); «—» significa
                que falta el gasto o no hubo resultados. Al agrupar solo cuentan los anuncios con
                gasto conocido.
              </p>
            ) : (
              <p>
                El origen es el que capturaste en el contacto; si no hay, se deduce «Anuncio»
                cuando Meta dijo de qué anuncio llegó. Aquí solo se cuenta: el costo por
                prospecto y el retorno necesitan conectar tu cuenta publicitaria (Ajustes → Anuncios).
              </p>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

/* ── Estado del conector ───────────────────────────────────────── */

function Estado({ hierarchy: h }: { hierarchy: AdsHierarchyDto }) {
  if (h.problem) {
    return (
      <p role="alert" className="mb-3 rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-xs text-danger-text">
        La conexión con tu cuenta publicitaria necesita atención: {h.problem} Corrígela en Ajustes → Anuncios.
      </p>
    );
  }
  if (h.mixedCurrency) {
    return (
      <p className="mb-3 rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
        Este periodo mezcla monedas distintas: no se suma el gasto ni se calculan costos.
      </p>
    );
  }
  if (h.connected && h.syncing) {
    return (
      <p className="mb-3 text-xs text-text-3" role="status" data-sincronizando>
        Trayendo de Meta el gasto de este periodo… lo que ves puede estar incompleto por unos minutos.
      </p>
    );
  }
  if (h.timezoneNote) {
    return (
      <p className="mb-3 rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
        {h.timezoneNote}
      </p>
    );
  }
  if (h.connected && h.pending > 0) {
    return (
      <p className="mb-3 text-xs text-text-3">
        Consultando a Meta el detalle de {h.pending} {h.pending === 1 ? "anuncio" : "anuncios"}…
      </p>
    );
  }
  return null;
}

/* ── Controles: nivel y filtros ────────────────────────────────── */

const NIVELES: { value: AdGroupBy; label: string }[] = [
  { value: "campaign", label: "Campaña" },
  { value: "adset", label: "Conjunto" },
  { value: "ad", label: "Anuncio" },
];

function Controles({
  data,
  view,
  onChange,
}: {
  data: AdsBlockDto;
  view: AdsView;
  onChange: (next: AdsView) => void;
}) {
  const campaigns = data.campaigns ?? [];
  const adsets = (data.adsets ?? []).filter((a) => !view.campaignId || view.campaignId === SIN_IDENTIFICAR || a.campaignId === view.campaignId);

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" data-controles-anuncios>
      <div role="group" aria-label="Agrupar por" className="inline-flex overflow-hidden rounded-md border">
        {NIVELES.map((n) => (
          <button
            key={n.value}
            type="button"
            aria-pressed={view.group === n.value}
            onClick={() => onChange(goToLevel(view, n.value))}
            className={cn(
              "px-3 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              view.group === n.value ? "bg-brand text-white" : "bg-card text-text-2 hover:bg-subtle"
            )}
          >
            {n.label}
          </button>
        ))}
      </div>

      <SearchSelect
        value={view.campaignId}
        // Cambiar de campaña invalida el conjunto elegido.
        onChange={(v) => onChange(pickCampaign(view, v))}
        options={[
          ...campaigns.map((c) => ({ value: c.id, label: c.name })),
          { value: SIN_IDENTIFICAR, label: "Sin identificar" },
        ]}
        emptyLabel="Todas las campañas"
        searchPlaceholder="Buscar campaña…"
        ariaLabel="Filtrar por campaña"
        triggerClassName="bg-card px-2 text-xs"
        minListWidth={220}
      />
      <SearchSelect
        value={view.adsetId}
        onChange={(v) => onChange(pickAdset(view, v))}
        options={[
          ...adsets.map((a) => ({ value: a.id, label: a.name })),
          { value: SIN_IDENTIFICAR, label: "Sin identificar" },
        ]}
        emptyLabel="Todos los conjuntos"
        searchPlaceholder="Buscar conjunto…"
        ariaLabel="Filtrar por conjunto de anuncios"
        triggerClassName="bg-card px-2 text-xs"
        minListWidth={220}
      />
    </div>
  );
}

/* ── Migas de pan ──────────────────────────────────────────────── */

function Migas({
  data,
  view,
  onChange,
}: {
  data: AdsBlockDto;
  view: AdsView;
  onChange: (next: AdsView) => void;
}) {
  const migas = crumbs(view, { campaigns: data.campaigns ?? [], adsets: data.adsets ?? [] });
  if (migas.length === 0) return null;
  return (
    <nav aria-label="Ubicación" className="mb-3 text-xs" data-migas>
      <ol className="flex flex-wrap items-center gap-1.5 text-text-3">
        {migas.map((m, i) => (
          <li key={`${i}-${m.label}`} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && <span aria-hidden>›</span>}
            {m.view ? (
              <button
                type="button"
                onClick={() => onChange(m.view!)}
                className="max-w-[16rem] truncate rounded text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {m.label}
              </button>
            ) : (
              <span aria-current="page" className="max-w-[16rem] truncate font-medium text-text-1">
                {m.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function SinCoincidencia({
  view,
  onViewChange,
  texto,
}: {
  view: AdsView;
  onViewChange?: (next: AdsView) => void;
  texto: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-text-3">
      <p>{texto}</p>
      {onViewChange && tieneFiltros(view) && (
        <button
          type="button"
          onClick={() => onViewChange({ ...VISTA_INICIAL, group: "campaign" })}
          className="rounded text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Quitar filtros
        </button>
      )}
    </div>
  );
}

/* ── El gasto de la cuenta y lo que no se pudo desglosar ───────── */

function Cuenta({
  hierarchy: h,
  total,
  filtrado,
  moneda,
}: {
  hierarchy: AdsHierarchyDto;
  total: AdTotalDto | undefined;
  filtrado: boolean;
  moneda: string | null;
}) {
  const lineas: ReactNode[] = [];
  if (h.account && !filtrado) {
    lineas.push(
      <p key="cuenta" data-gasto-cuenta>
        Gasto de tu cuenta en Meta en este periodo: <span className="font-medium tabular-nums text-text-2">{dinero(h.account.spend, moneda)}</span>
        {h.account.unattributed === null ? " · coincide con la suma de los anuncios." : null}
      </p>
    );
    if (h.account.unattributed !== null) {
      lineas.push(
        <p key="diff" data-sin-desglosar className="text-warning-text">
          Sin desglosar por anuncio: <span className="font-medium tabular-nums">{dinero(h.account.unattributed, moneda)}</span>.
          Es gasto que Meta cuenta en la cuenta pero ya no devuelve a nivel de anuncio (por ejemplo, anuncios eliminados).
        </p>
      );
    }
  }
  if (total && total.ads > 50 && !filtrado) {
    lineas.push(
      <p key="recorte">
        La lista muestra los 50 anuncios con más conversaciones de {total.ads}; el total de abajo cuenta todos. Agrupa
        por campaña o conjunto, o filtra, para ver el resto.
      </p>
    );
  }
  if (lineas.length === 0) return null;
  return <div className="space-y-1 text-[11px] text-text-3">{lineas}</div>;
}

/* ── Tabla ─────────────────────────────────────────────────────── */

type Fila = {
  key: string;
  titulo: ReactNode;
  conteos: Conteos;
  sourceId?: string | null;
  bookings?: number | null;
  costs?: Partial<SpendDto>;
};

function dinero(valor: number | null | undefined, moneda: string | null): string {
  if (valor === null || valor === undefined) return "—";
  try {
    return new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: moneda ?? "USD",
      currencyDisplay: moneda ? "symbol" : "code",
      maximumFractionDigits: 2,
    }).format(valor);
  } catch {
    return valor.toFixed(2);
  }
}

/** La misma lista como tabla (desde `sm`) o como tarjetas (teléfono). */
function Filas({
  primera,
  filas,
  conGasto,
  conCitas,
  moneda,
  total,
}: {
  primera: string;
  filas: Fila[];
  conGasto: boolean;
  conCitas: boolean;
  moneda: string | null;
  /** 039 — Total de todo lo filtrado (solo con la Marketing API). */
  total?: AdTotalDto;
}) {
  return (
    <>
      <ul className="divide-y border-y text-sm sm:hidden">
        {filas.map((f) => (
          <li key={f.key} className="py-2.5" data-anuncio={f.sourceId ?? undefined}>
            {f.titulo}
            <dl className="mt-2 grid grid-cols-4 gap-2 text-center">
              <Dato etiqueta="conversaciones" valor={f.conteos.conversations} />
              <Dato etiqueta="prospectos" valor={f.conteos.leads} />
              <Dato etiqueta="ventas" valor={f.conteos.won} />
              <div className="min-w-0">
                <dt className="sr-only">Cierre</dt>
                <dd className="text-sm font-semibold">
                  <TasaCorta rate={f.conteos.winRate} conDenominador={false} />
                </dd>
                <dd className="truncate text-[11px] text-text-3">
                  {f.conteos.winRate.value === null ? "cierre" : `cierre de ${f.conteos.winRate.sample}`}
                </dd>
              </div>
            </dl>
            {conGasto && (
              <dl className="mt-2 grid grid-cols-4 gap-2 text-center" data-gasto>
                <DatoTexto etiqueta="gasto" valor={dinero(f.costs?.spend, moneda)} />
                <DatoTexto etiqueta="por conversación" valor={dinero(f.costs?.costPerConversation, moneda)} />
                <DatoTexto etiqueta="por prospecto" valor={dinero(f.costs?.costPerLead, moneda)} />
                <DatoTexto etiqueta="por cita" valor={conCitas ? dinero(f.costs?.costPerBooking, moneda) : "—"} />
              </dl>
            )}
          </li>
        ))}
        {total && (
          <li className="py-2.5" data-total>
            <p className="font-semibold">Total</p>
            <dl className="mt-2 grid grid-cols-4 gap-2 text-center">
              <Dato etiqueta="conversaciones" valor={total.conversations} />
              <Dato etiqueta="prospectos" valor={total.leads} />
              <Dato etiqueta="ventas" valor={total.won} />
              <DatoTexto etiqueta="gasto" valor={dinero(total.spend, moneda)} />
            </dl>
          </li>
        )}
      </ul>

      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs text-text-3">
              <th scope="col" className="py-1.5 pr-2 text-left font-medium">
                {primera}
              </th>
              <Num>Conversaciones</Num>
              <Num>Prospectos</Num>
              {conCitas && <Num>Citas</Num>}
              <Num>Ventas</Num>
              <Num>Cierre</Num>
              {conGasto && (
                <>
                  <Num>Gasto</Num>
                  <Num>Costo / conv.</Num>
                  <Num>Costo / prospecto</Num>
                  {conCitas && <Num>Costo / cita</Num>}
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.key} className="border-b last:border-0" data-anuncio={f.sourceId ?? undefined}>
                <td className="py-2 pr-3">{f.titulo}</td>
                <Cell>{f.conteos.conversations}</Cell>
                <Cell>{f.conteos.leads}</Cell>
                {conCitas && <Cell>{f.bookings ?? "—"}</Cell>}
                <Cell>{f.conteos.won}</Cell>
                <Cell>
                  <TasaCorta rate={f.conteos.winRate} />
                </Cell>
                {conGasto && (
                  <>
                    <Cell>{dinero(f.costs?.spend, moneda)}</Cell>
                    <Cell>{dinero(f.costs?.costPerConversation, moneda)}</Cell>
                    <Cell>{dinero(f.costs?.costPerLead, moneda)}</Cell>
                    {conCitas && <Cell>{dinero(f.costs?.costPerBooking, moneda)}</Cell>}
                  </>
                )}
              </tr>
            ))}
          </tbody>
          {total && (
            <tfoot data-total>
              <tr className="border-t-2 font-semibold">
                <td className="py-2 pr-3">Total</td>
                <Cell>{total.conversations}</Cell>
                <Cell>{total.leads}</Cell>
                {conCitas && <Cell>{total.bookings ?? "—"}</Cell>}
                <Cell>{total.won}</Cell>
                <Cell>
                  <TasaCorta rate={rate(total.won, total.leads)} />
                </Cell>
                {conGasto && (
                  <>
                    <Cell>{dinero(total.spend, moneda)}</Cell>
                    <Cell>{dinero(total.costPerConversation, moneda)}</Cell>
                    <Cell>{dinero(total.costPerLead, moneda)}</Cell>
                    {conCitas && <Cell>{dinero(total.costPerBooking, moneda)}</Cell>}
                  </>
                )}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </>
  );
}

const ESTADO_ETIQUETA: Record<Exclude<GroupStatus, null>, string> = {
  active: "Activa",
  paused: "Pausada",
  archived: "Archivada",
  mixed: "Mixta",
};

/** El estado en Meta; solo se pinta si se conoce y NO es el normal (un «Activa» en cada fila es ruido). */
function EstadoMeta({ estado }: { estado: GroupStatus | AdStatus | undefined }) {
  if (!estado || estado === "active") return null;
  return (
    <Badge variant={estado === "paused" ? "warning" : "secondary"} className="ml-1.5 align-middle" data-estado={estado}>
      {ESTADO_ETIQUETA[estado]}
    </Badge>
  );
}

function Anuncio({ anuncio: a }: { anuncio: AdRowDto }) {
  const titular = a.adName ?? titularDeOrigen(a.headline, a.sourceType);
  const ruta = [a.campaignName, a.adsetName].filter(Boolean).join(" › ");
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <MiniaturaDeAnuncio imageAssetId={a.imageAssetId} alt={`Creativo: ${titular}`} />
      <div className="min-w-0">
        <p className="truncate font-medium sm:max-w-[20rem]" title={titular}>
          {titular}
          <EstadoMeta estado={a.status} />
        </p>
        {ruta && (
          <p className="truncate text-[11px] text-text-2 sm:max-w-[20rem]" title={ruta} data-jerarquia>
            {ruta}
          </p>
        )}
        <p className="truncate text-[11px] text-text-3 sm:max-w-[20rem]">
          {etiquetaDeOrigen(a.sourceType)}
          {a.sourceId && <span className="font-mono"> · {a.sourceId}</span>}
        </p>
      </div>
    </div>
  );
}

function Grupo({ grupo: g, onAbrir }: { grupo: AdGroupRowDto; onAbrir?: () => void }) {
  const nombre = (
    <>
      {g.name}
      <EstadoMeta estado={g.status} />
    </>
  );
  return (
    <div className="min-w-0">
      {onAbrir ? (
        <button
          type="button"
          onClick={onAbrir}
          title={`Ver ${g.level === "campaign" ? "los conjuntos" : "los anuncios"} de ${g.name}`}
          data-abrir={g.key}
          className="block max-w-full truncate rounded text-left font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-[20rem]"
        >
          {nombre}
        </button>
      ) : (
        <p className="truncate font-medium sm:max-w-[20rem]" title={g.name}>
          {nombre}
        </p>
      )}
      <p className="truncate text-[11px] text-text-3 sm:max-w-[20rem]">
        {g.campaignName ? `${g.campaignName} · ` : ""}
        {g.ads} {g.ads === 1 ? "anuncio" : "anuncios"}
      </p>
    </div>
  );
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: number }) {
  return <DatoTexto etiqueta={etiqueta} valor={String(valor)} />;
}

function DatoTexto({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="min-w-0">
      <dt className="sr-only">{etiqueta}</dt>
      <dd className="truncate text-sm font-semibold tabular-nums">{valor}</dd>
      <dd className="truncate text-[11px] text-text-3" aria-hidden>
        {etiqueta}
      </dd>
    </div>
  );
}

function Num({ children }: { children: ReactNode }) {
  return (
    <th scope="col" className="whitespace-nowrap py-1.5 pl-2 text-right font-medium">
      {children}
    </th>
  );
}

function Cell({ children }: { children: ReactNode }) {
  return <td className="whitespace-nowrap py-2 pl-2 text-right tabular-nums">{children}</td>;
}

/**
 * La tasa de una fila: el porcentaje con su denominador, atenuada con muestra
 * chica (la nota al pie lo explica) para no ensanchar la columna.
 */
function TasaCorta({ rate, conDenominador = true }: { rate: RateDto; conDenominador?: boolean }) {
  if (rate.value === null) return <span className="text-text-3">—</span>;
  return (
    <span
      className={cn(!rate.reliable && "text-text-3")}
      title={`${rate.value}% de ${rate.sample} prospectos${rate.reliable ? "" : " · muestra chica"}`}
    >
      {rate.value}%
      {conDenominador && <span className="ml-1 text-[11px] text-text-3">de {rate.sample}</span>}
    </span>
  );
}
