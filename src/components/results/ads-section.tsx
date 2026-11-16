"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye } from "lucide-react";
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
  filtersFor,
  goToLevel,
  masterState,
  pickAdset,
  pickCampaign,
  seleccionDe,
  SIN_IDENTIFICAR,
  summary,
  tieneFiltros,
  toggle,
  toggleAll,
  VISTA_INICIAL,
  VISTA_POR_CAMPANA,
  type AdsView,
} from "@/lib/ads-nav";
import { AnuncioPreviewDialog } from "@/components/results/anuncio-preview-dialog";
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
  const [preview, setPreview] = useState<AdRowDto | null>(null);

  // 040 — Casillas: solo con la jerarquía de Meta (sin ella no hay niveles que filtrar). Actúan sobre las filas visibles.
  const conSeleccion = !!h && (h.connected || h.hasData) && !!onViewChange;
  const llavesVisibles = !data ? [] : agrupado ? (data.groups ?? []).map((g) => g.key) : data.ads.map((a) => a.key);
  const seleccion: Seleccion | undefined =
    conSeleccion && onViewChange
      ? {
          marcadas: seleccionDe(view, view.group),
          visibles: llavesVisibles,
          onToggle: (k) => onViewChange(toggle(view, view.group, k)),
          onToggleAll: (on) => onViewChange(toggleAll(view, view.group, llavesVisibles, on)),
          noun: view.group === "campaign" ? "campaña" : view.group === "adset" ? "conjunto" : "anuncio",
        }
      : undefined;
  const rotuloTotal =
    data && data.selectedCount && data.selectedCount > 0
      ? `Total · ${data.selectedCount} ${data.selectedCount === 1 ? (view.group === "campaign" ? "seleccionada" : "seleccionado") : view.group === "campaign" ? "seleccionadas" : "seleccionados"}`
      : "Total";

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
            {seleccion && onViewChange && (
              <Pildoras view={view} visibles={llavesVisibles} onChange={onViewChange} onMarcarTodo={() => seleccion.onToggleAll(true)} />
            )}

            {agrupado ? (
              data.groups && data.groups.length > 0 ? (
                <Filas
                  primera={data.groupBy === "campaign" ? "Campaña" : "Conjunto"}
                  conGasto={conGasto}
                  conCitas={conCitas}
                  moneda={moneda}
                  total={conGasto ? data.total : undefined}
                  rotuloTotal={rotuloTotal}
                  seleccion={seleccion}
                  filas={data.groups.map((g) => ({
                    key: g.key,
                    llave: g.key,
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
                rotuloTotal={rotuloTotal}
                seleccion={seleccion}
                filas={data.ads.map((a) => ({
                  key: a.key,
                  llave: a.key,
                  titulo: <Anuncio anuncio={a} onPreview={conSeleccion ? () => setPreview(a) : undefined} />,
                  conteos: a,
                  sourceId: a.sourceId,
                  bookings: a.bookings ?? null,
                  costs: a,
                }))}
              />
            )}
          </div>

          {h && conGasto && <Cuenta hierarchy={h} total={data.total} filtrado={filtrosDeArriba(view)} moneda={moneda} />}
          {preview && <AnuncioPreviewDialog anuncio={preview} onClose={() => setPreview(null)} />}

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
  const campanasMarcadas = view.campaignIds;
  const adsets = (data.adsets ?? []).filter(
    (a) => campanasMarcadas.length === 0 || campanasMarcadas.includes(SIN_IDENTIFICAR) || (a.campaignId !== null && campanasMarcadas.includes(a.campaignId))
  );
  const valorCampana = view.campaignIds.length === 1 ? view.campaignIds[0]! : "";
  const valorConjunto = view.adsetIds.length === 1 ? view.adsetIds[0]! : "";

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
        value={valorCampana}
        // Cambiar de campaña invalida el conjunto elegido.
        onChange={(v) => onChange(pickCampaign(view, v))}
        options={[
          ...campaigns.map((c) => ({ value: c.id, label: c.name })),
          { value: SIN_IDENTIFICAR, label: "Sin identificar" },
        ]}
        emptyLabel={view.campaignIds.length > 1 ? `${view.campaignIds.length} campañas` : "Todas las campañas"}
        searchPlaceholder="Buscar campaña…"
        ariaLabel="Filtrar por campaña"
        triggerClassName="bg-card px-2 text-xs"
        minListWidth={220}
      />
      <SearchSelect
        value={valorConjunto}
        onChange={(v) => onChange(pickAdset(view, v))}
        options={[
          ...adsets.map((a) => ({ value: a.id, label: a.name })),
          { value: SIN_IDENTIFICAR, label: "Sin identificar" },
        ]}
        emptyLabel={view.adsetIds.length > 1 ? `${view.adsetIds.length} conjuntos` : "Todos los conjuntos"}
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
          onClick={() => onViewChange({ ...VISTA_POR_CAMPANA })}
          className="rounded text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Quitar filtros
        </button>
      )}
    </div>
  );
}

/** ¿Hay un filtro que viene de arriba de esta pestaña? (la cuenta completa solo se compara sin filtros). */
function filtrosDeArriba(view: AdsView): boolean {
  const f = filtersFor(view);
  return f.campaignIds.length > 0 || f.adsetIds.length > 0;
}

/* ── Casillas y píldoras (040) ─────────────────────────────────── */

type Seleccion = {
  marcadas: string[];
  visibles: string[];
  onToggle: (key: string) => void;
  onToggleAll: (on: boolean) => void;
  /** «campaña», «conjunto» o «anuncio»: para las etiquetas de accesibilidad. */
  noun: string;
};

/** Una casilla nativa (con teclado y lector de pantalla); la maestra admite el estado intermedio. */
function Casilla({
  checked,
  indeterminate = false,
  onChange,
  label,
  dato,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (on: boolean) => void;
  label: string;
  dato?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={label}
      data-casilla={dato}
      className="h-4 w-4 shrink-0 cursor-pointer rounded border-border-strong accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}

function Pildoras({
  view,
  visibles,
  onChange,
  onMarcarTodo,
}: {
  view: AdsView;
  visibles: string[];
  onChange: (next: AdsView) => void;
  onMarcarTodo: () => void;
}) {
  const { filtro, seleccion } = summary(view, visibles);
  const hay = !!filtro || !!seleccion;
  return (
    // En el teléfono no hay cabecera de tabla con casilla maestra: «Marcar todo» vive aquí.
    <div className={cn("mb-3 flex flex-wrap items-center gap-2 text-xs", !hay && "sm:hidden")} data-pildoras>
      {filtro && (
        <span className="inline-flex items-center gap-1.5 rounded-full border bg-subtle px-2.5 py-1" data-pildora-filtro>
          <span>
            Filtrando: <span className="font-medium">{filtro.texto}</span>
          </span>
          <button type="button" onClick={() => onChange(filtro.accion)} className="text-brand underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Quitar
          </button>
        </span>
      )}
      {seleccion && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand/5 px-2.5 py-1" data-pildora-seleccion>
          <span className="font-medium">{seleccion.texto}</span>
          <button type="button" onClick={() => onChange(seleccion.accion)} className="text-brand underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Limpiar
          </button>
        </span>
      )}
      <button
        type="button"
        onClick={onMarcarTodo}
        className="rounded-full border px-2.5 py-1 text-brand sm:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Marcar todo
      </button>
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
  /** 040 — La llave que guardan las casillas (id de campaña/conjunto, o la del anuncio). */
  llave?: string;
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
  rotuloTotal = "Total",
  seleccion,
}: {
  primera: string;
  filas: Fila[];
  conGasto: boolean;
  conCitas: boolean;
  moneda: string | null;
  /** 039 — Total de todo lo filtrado (solo con la Marketing API); con casillas marcadas, el de ellas (040). */
  total?: AdTotalDto;
  rotuloTotal?: string;
  /** 040 — Casillas; sin esto la tabla es la de siempre. */
  seleccion?: Seleccion;
}) {
  const marcada = (f: Fila) => !!seleccion && !!f.llave && seleccion.marcadas.includes(f.llave);
  const estadoMaestra = seleccion ? masterState(seleccion.marcadas, seleccion.visibles) : "none";
  return (
    <>
      <ul className="divide-y border-y text-sm sm:hidden">
        {filas.map((f) => (
          <li key={f.key} className={cn("py-2.5", marcada(f) && "bg-brand/5")} data-anuncio={f.sourceId ?? undefined}>
            <div className="flex items-start gap-2.5">
              {seleccion && f.llave && (
                <span className="pt-1">
                  <Casilla
                    checked={marcada(f)}
                    onChange={() => seleccion.onToggle(f.llave!)}
                    label={`Seleccionar ${seleccion.noun}`}
                    dato={f.llave}
                  />
                </span>
              )}
              <div className="min-w-0 flex-1">{f.titulo}</div>
            </div>
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
            <p className="font-semibold">{rotuloTotal}</p>
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
              {seleccion && (
                <th scope="col" className="w-8 py-1.5 pr-1 text-left">
                  <Casilla
                    checked={estadoMaestra === "all"}
                    indeterminate={estadoMaestra === "some"}
                    onChange={(on) => seleccion.onToggleAll(on)}
                    label={`Seleccionar todas las filas visibles (${seleccion.noun}s)`}
                    dato="todas"
                  />
                </th>
              )}
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
              <tr key={f.key} className={cn("border-b last:border-0", marcada(f) && "bg-brand/5")} data-anuncio={f.sourceId ?? undefined}>
                {seleccion && (
                  <td className="py-2 pr-1 align-middle">
                    {f.llave && (
                      <Casilla
                        checked={marcada(f)}
                        onChange={() => seleccion.onToggle(f.llave!)}
                        label={`Seleccionar ${seleccion.noun}`}
                        dato={f.llave}
                      />
                    )}
                  </td>
                )}
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
                {seleccion && <td />}
                <td className="py-2 pr-3" data-total-rotulo>
                  {rotuloTotal}
                </td>
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

function Anuncio({ anuncio: a, onPreview }: { anuncio: AdRowDto; onPreview?: () => void }) {
  const titular = a.adName ?? titularDeOrigen(a.headline, a.sourceType);
  const ruta = [a.campaignName, a.adsetName].filter(Boolean).join(" › ");
  // La imagen del referral (la que vio el cliente) y, si no, la copia del catálogo de Meta (también la de un anuncio
  // con gasto y sin conversaciones). Sin ninguna, el megáfono de siempre.
  const imagen = a.imageAssetId ?? a.creative?.assetId ?? null;
  const miniatura = <MiniaturaDeAnuncio imageAssetId={imagen} alt={`Creativo: ${titular}`} />;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {onPreview ? (
        <button
          type="button"
          onClick={onPreview}
          aria-label={`Vista previa del anuncio ${titular}`}
          title="Ver vista previa"
          data-preview={a.key}
          className="shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {miniatura}
        </button>
      ) : (
        miniatura
      )}
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
      {onPreview && (
        <button
          type="button"
          onClick={onPreview}
          aria-label={`Ver vista previa de ${titular}`}
          title="Vista previa"
          data-preview-boton={a.key}
          className="ml-auto shrink-0 rounded p-1.5 text-text-3 hover:bg-subtle hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Eye className="h-4 w-4" aria-hidden />
        </button>
      )}
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
