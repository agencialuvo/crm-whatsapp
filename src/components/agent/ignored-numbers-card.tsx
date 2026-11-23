"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ClipboardPaste, Plus, UserX } from "lucide-react";
import { CHANNEL_LABEL, type Channel } from "@/lib/channels";
import {
  IGNORED_LABEL_MAX,
  ignoreKeyOf,
  parseIgnoredInput,
  type InvalidIgnoredLine,
  type ParsedIgnoredEntry,
} from "@/lib/ignored-number";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchInput } from "@/components/ui/search-input";
import { Textarea } from "@/components/ui/textarea";

/**
 * Agente → «Números que el agente ignora». Plegada por defecto: es una excepción, no el trabajo de todos los días.
 *
 * El mensaje de estas personas sigue llegando a la Bandeja; solo el agente (el incluido y el cerebro externo) deja
 * de contestarles. La lista es la fuente de verdad (`ignored_number`): quitar a alguien surte efecto al instante.
 * Escribir (agregar, pegar varios, quitar) es de quien configura (`canConfigure`); el resto del equipo solo la ve.
 */

export type IgnoredEntryDto = {
  id: string;
  channel: Channel;
  key: string;
  display: string;
  label: string | null;
  createdAt: string;
};

type BulkResult = {
  added: IgnoredEntryDto[];
  duplicates: ParsedIgnoredEntry[];
  invalid: InvalidIgnoredLine[];
  overLimit: ParsedIgnoredEntry[];
};

/** Pasa de este número de entradas aparece el buscador. */
const SEARCH_FROM = 10;
const DEFAULT_LIMIT = 500;

const fecha = (iso: string) =>
  new Date(iso).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });

type ApiResult<T> = { ok: boolean; status: number; data: T | null; message: string | null };

/** `fetch` con JSON que nunca lanza: un corte de red se vuelve `status: 0` con un mensaje que se puede mostrar. */
async function call<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    return { ok: res.ok, status: res.status, data, message: data?.error?.message ?? null };
  } catch {
    return { ok: false, status: 0, data: null, message: "No se pudo conectar. Revisa tu conexión e inténtalo de nuevo." };
  }
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** La línea repite un número de otra línea del mismo texto (`parseIgnoredInput`: «Repetido: ya está en la línea N»). */
const isRepeated = (l: InvalidIgnoredLine) => l.reason.startsWith("Repetido");

export function IgnoredNumbersCard({ canConfigure }: { canConfigure: boolean }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<IgnoredEntryDto[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState("");

  const [number, setNumber] = useState("");
  const [touched, setTouched] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await call<{ entries: IgnoredEntryDto[]; total: number; limit: number }>("/api/agent/ignored-numbers");
    if (r.ok && r.data) {
      setEntries(r.data.entries);
      setTotal(r.data.total);
      setLimit(r.data.limit);
      setLoadError(false);
    } else {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Validación en vivo con la MISMA regla del servidor (`ignoreKeyOf`): lo que aquí se ve bien, allá se acepta.
  const parsed = useMemo(() => (number.trim() ? ignoreKeyOf(number) : null), [number]);
  const atLimit = total >= limit;
  const bulkPreview = useMemo(() => (bulkText.trim() ? parseIgnoredInput(bulkText) : null), [bulkText]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    const digits = q.replace(/\D/g, "");
    return entries.filter(
      (e) =>
        e.display.toLowerCase().includes(q) ||
        (digits.length > 0 && e.key.includes(digits)) ||
        (e.label ?? "").toLowerCase().includes(q)
    );
  }, [entries, search]);

  async function add() {
    setTouched(true);
    if (!parsed?.ok || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await call<{ entry: IgnoredEntryDto }>(
      "/api/agent/ignored-numbers",
      jsonInit("POST", { number, label: label.trim() || undefined })
    );
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.message ?? "No se pudo agregar el número.");
      return;
    }
    setNotice(`Listo: el agente ya no le contesta a ${r.data.entry.display}.`);
    setNumber("");
    setLabel("");
    setTouched(false);
    await load();
  }

  async function addBulk() {
    if (!bulkPreview || bulkPreview.valid.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await call<BulkResult>("/api/agent/ignored-numbers", jsonInit("POST", { bulk: bulkText }));
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.message ?? "No se pudo agregar la lista.");
      return;
    }
    setBulkResult(r.data);
    // Lo que no se pudo leer vuelve al cuadro para corregirlo sin volver a pegar lo demás. Una línea «Repetido» no
    // se devuelve: su número ya entró con la primera aparición y no hay nada que corregir.
    setBulkText(r.data.invalid.filter((l) => !isRepeated(l)).map((l) => l.text).join("\n"));
    await load();
  }

  async function remove(entry: IgnoredEntryDto) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await call<{ ok: boolean }>(`/api/agent/ignored-numbers/${entry.id}`, { method: "DELETE" });
    setBusy(false);
    setConfirmingId(null);
    if (!r.ok) {
      setError(r.message ?? "No se pudo quitar el número.");
      return;
    }
    setNotice(`Se quitó ${entry.display}: el agente volverá a contestarle.`);
    await load();
  }

  const showNumberError = touched && parsed && !parsed.ok;

  return (
    <Card>
      <CardHeader className="p-0">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="ignored-numbers-body"
          className="flex w-full items-center justify-between gap-3 rounded-lg p-6 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              Números que el agente ignora
              <Badge variant="secondary">{total}</Badge>
            </CardTitle>
            <CardDescription className="mt-1.5">
              Familia, proveedores o cualquiera a quien prefieras atender tú. Sus mensajes llegan a tu Bandeja; el agente no contesta.
            </CardDescription>
          </div>
          <ChevronDown
            className={cn("h-5 w-5 shrink-0 text-text-3 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
      </CardHeader>

      {open && (
        <CardContent id="ignored-numbers-body" className="space-y-4">
          <p className="text-xs text-text-2">El mensaje sigue llegando a tu Bandeja. Solo el agente deja de contestar.</p>

          {canConfigure ? (
            <div className="space-y-3 rounded-md border p-3">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="ignored-number">Número con código de país</Label>
                  <Input
                    id="ignored-number"
                    inputMode="tel"
                    autoComplete="off"
                    placeholder="+51 987 654 321"
                    value={number}
                    maxLength={40}
                    aria-invalid={showNumberError ? true : undefined}
                    aria-describedby="ignored-number-hint"
                    onChange={(e) => setNumber(e.target.value)}
                    onBlur={() => setTouched(true)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void add();
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ignored-label">Nota (opcional)</Label>
                  <Input
                    id="ignored-label"
                    placeholder="p. ej. Mamá"
                    value={label}
                    maxLength={IGNORED_LABEL_MAX}
                    onChange={(e) => setLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void add();
                    }}
                  />
                </div>
                <Button onClick={() => void add()} disabled={busy || atLimit || !parsed?.ok}>
                  <Plus className="h-4 w-4" /> Agregar
                </Button>
              </div>
              <p
                id="ignored-number-hint"
                role={showNumberError ? "alert" : undefined}
                className={cn("min-h-4 text-xs", showNumberError ? "text-danger-text" : "text-text-3")}
              >
                {showNumberError && parsed && !parsed.ok
                  ? parsed.error
                  : parsed?.ok
                    ? `Se ignorará +${parsed.key}`
                    : "Escríbelo con el código de país, por ejemplo +51…"}
              </p>
              {atLimit && (
                <p className="text-xs text-warning-text">
                  Llegaste al tope de {limit} números. Quita alguno para agregar más.
                </p>
              )}

              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setBulkOpen((o) => !o);
                    setBulkResult(null);
                  }}
                  aria-expanded={bulkOpen}
                >
                  <ClipboardPaste className="h-4 w-4" /> Pegar varios
                </Button>
              </div>

              {bulkOpen && (
                <div className="space-y-2">
                  <Label htmlFor="ignored-bulk">Un número por línea (la nota va después de una coma)</Label>
                  <Textarea
                    id="ignored-bulk"
                    rows={6}
                    placeholder={"+51 987 654 321, Mamá\n+52 55 1234 5678, Proveedor"}
                    value={bulkText}
                    onChange={(e) => {
                      setBulkText(e.target.value);
                      setBulkResult(null);
                    }}
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <Button size="sm" onClick={() => void addBulk()} disabled={busy || !bulkPreview || bulkPreview.valid.length === 0}>
                      Agregar lista
                    </Button>
                    {bulkPreview && (
                      <p className="text-xs text-text-2" aria-live="polite">
                        {plural(bulkPreview.valid.length, "número válido", "números válidos")}
                        {bulkPreview.invalid.length > 0 && ` · ${plural(bulkPreview.invalid.length, "línea con problema", "líneas con problemas")}`}
                      </p>
                    )}
                  </div>
                  {bulkPreview && bulkPreview.invalid.length > 0 && !bulkResult && (
                    <ul className="space-y-0.5 text-xs text-warning-text">
                      {bulkPreview.invalid.map((l) => (
                        <li key={l.line}>
                          Línea {l.line}: {l.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {bulkResult && <BulkSummary result={bulkResult} limit={limit} />}
            </div>
          ) : (
            <p className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-2">
              Solo el dueño o un administrador puede cambiar esta lista.
            </p>
          )}

          <div aria-live="polite">
            {error && (
              <p role="alert" className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-xs text-danger-text">
                {error}
              </p>
            )}
            {notice && !error && (
              <p role="status" className="rounded-md border border-success-soft bg-success-tint px-3 py-2 text-xs text-success-text">
                {notice}
              </p>
            )}
          </div>

          {total > SEARCH_FROM && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SearchInput value={search} onChange={setSearch} placeholder="Buscar por número o nota" />
              <p className="text-xs text-text-3">
                {search.trim()
                  ? `${visible.length} de ${total}`
                  : `${total} de ${limit}`}
              </p>
            </div>
          )}

          {loadError && (
            <p className="text-xs text-danger-text">
              No se pudo cargar la lista.{" "}
              <button type="button" className="font-medium underline underline-offset-2" onClick={() => void load()}>
                Reintentar
              </button>
            </p>
          )}

          <ul className="space-y-2">
            {visible.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium tabular-nums">
                    {e.display}
                    {e.channel !== "whatsapp" && <Badge variant="secondary">{CHANNEL_LABEL[e.channel]}</Badge>}
                  </p>
                  <p className="text-xs text-text-3">
                    {e.label ? `${e.label} · ` : ""}
                    desde {fecha(e.createdAt)}
                  </p>
                </div>
                {canConfigure &&
                  (confirmingId === e.id ? (
                    <div className="flex items-center gap-2" role="group" aria-label={`Confirmar quitar ${e.display}`}>
                      <span className="text-xs text-text-2">¿Quitar? El agente volverá a contestarle.</span>
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove(e)}>
                        Sí, quitar
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmingId(null)}>
                        Cancelar
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Quitar ${e.display}`}
                      onClick={() => {
                        setConfirmingId(e.id);
                        setNotice(null);
                      }}
                    >
                      <UserX className="h-4 w-4" /> Quitar
                    </Button>
                  ))}
              </li>
            ))}
            {entries.length === 0 && !loadError && (
              <li className="py-2 text-center text-xs text-text-3">
                Ninguno todavía: el agente le contesta a todos.
              </li>
            )}
            {entries.length > 0 && visible.length === 0 && (
              <li className="py-2 text-center text-xs text-text-3">Ninguno coincide con la búsqueda.</li>
            )}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

/** El resumen de «Pegar varios»: qué entró, qué ya estaba, qué no se pudo leer y qué no cupo. */
function BulkSummary({ result, limit }: { result: BulkResult; limit: number }) {
  const { added, duplicates, invalid, overLimit } = result;
  return (
    <div className="space-y-1.5 rounded-md border bg-subtle p-3 text-xs" role="status">
      <p className={cn("font-medium", added.length > 0 ? "text-success-text" : "text-text-2")}>
        {added.length > 0 ? `${plural(added.length, "número agregado", "números agregados")}.` : "No se agregó ningún número."}
      </p>
      {duplicates.length > 0 && (
        <p className="text-text-2">
          Ya estaban en la lista ({duplicates.length}): {duplicates.map((d) => `+${d.key}`).join(", ")}.
        </p>
      )}
      {overLimit.length > 0 && (
        <p className="text-warning-text">
          No cupieron {overLimit.length} por el tope de {limit}. Quita alguno y vuelve a pegarlos.
        </p>
      )}
      {invalid.length > 0 && (
        <div className="text-warning-text">
          <p>
            No se pudieron leer {plural(invalid.length, "línea", "líneas")}
            {invalid.some((l) => !isRepeated(l)) ? " (las corregibles siguen en el cuadro):" : ":"}
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {invalid.map((l) => (
              <li key={l.line}>
                Línea {l.line}: {l.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
