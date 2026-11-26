"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/search-select";
import { MAX_BUSY_CALENDARS, type CalendarRef, type GoogleCalendarOption } from "@/lib/google-calendar";

/**
 * Mejora 2 — Elegir en qué calendario de Google se publican las citas y cuáles se leen como ocupado.
 *
 * Se muestra dentro de la tarjeta de Google Calendar cuando hay conexión. Según lo que diga el servidor:
 *  - `flag_off`: no se muestra nada (todo sigue en el calendario principal, como antes).
 *  - `needs_reconnect`: la conexión no tiene el permiso de la lista → aviso con «Reconectar con Google».
 *  - `manual_no_scope`: credenciales propias sin ese permiso → cómo resolverlo (o el ID en «Avanzado»).
 *  - disponible: un selector para publicar y casillas para leer (hasta 10).
 */

type Choices = {
  available: boolean;
  reason: "flag_off" | "needs_reconnect" | "manual_no_scope" | "error" | null;
  error?: string;
  calendars: GoogleCalendarOption[];
  selection: { publish: CalendarRef; busy: CalendarRef[] };
};

/** El selector, separado del resto de la tarjeta por una línea (nada si no aplica). */
export function GoogleCalendarPicker(props: { reconnectHref: string | null; onSaved: () => void }) {
  return <PickerBody {...props} wrap={(node) => <div className="border-t pt-3">{node}</div>} />;
}

function PickerBody({
  wrap,
  reconnectHref,
  onSaved,
}: {
  /** «Reconectar con Google» (null si la instancia no tiene app OAuth). */
  reconnectHref: string | null;
  /** Se guardó: la tarjeta refresca su estado (nombre del calendario, lectura de lo ocupado). */
  onSaved: () => void;
  wrap: (node: React.ReactNode) => React.ReactNode;
}) {
  const [choices, setChoices] = useState<Choices | null | undefined>(undefined);
  const [publishId, setPublishId] = useState("");
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/google/calendars").catch(() => null);
    if (!res?.ok) return setChoices(null);
    const data = (await res.json()) as Choices;
    setChoices(data);
    setPublishId(data.selection.publish.id);
    setBusyIds(data.selection.busy.map((c) => c.id));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!choices) return false;
    const saved = choices.selection.busy.map((c) => c.id).sort().join("|");
    return publishId !== choices.selection.publish.id || [...busyIds].sort().join("|") !== saved;
  }, [choices, publishId, busyIds]);

  if (!choices || choices.reason === "flag_off") return null;

  if (choices.reason === "needs_reconnect") {
    return wrap(
      <div className="space-y-2 rounded-sm bg-brand-tint p-3 text-sm text-brand-text">
        <p className="font-medium">Nuevo: elige tus calendarios</p>
        <p>
          Puedes publicar las citas en otro calendario (por ejemplo, uno del equipo) y tener en cuenta lo ocupado en
          varios. Reconecta con Google y acepta «Ver la lista de tus calendarios». Mientras tanto, todo sigue en tu
          calendario principal.
        </p>
        {reconnectHref && (
          <a href={reconnectHref} className={buttonVariants({ size: "sm" })}>Reconectar con Google</a>
        )}
      </div>
    );
  }

  if (choices.reason === "manual_no_scope") {
    return wrap(
      <p className="text-xs text-text-3">
        Para elegir entre tus calendarios, genera el refresh token de tu app con el permiso
        «calendar.calendarlist.readonly». Mientras tanto, puedes escribir el ID del calendario donde publicar en
        «Avanzado».
      </p>
    );
  }

  if (choices.reason === "error") {
    return wrap(
      <div className="space-y-2">
        <p role="status" className="rounded-sm border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
          No se pudo traer tu lista de calendarios{choices.error ? `: ${choices.error}` : ""}. La agenda sigue con lo
          elegido.
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()}>Reintentar</Button>
      </div>
    );
  }

  const publishable = choices.calendars.filter((c) => c.canPublish);

  function toggle(id: string) {
    setNotice(null);
    setBusyIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  async function save() {
    setSaving(true);
    setNotice(null);
    const res = await fetch("/api/settings/google/calendars", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publishCalendarId: publishId, busyCalendarIds: busyIds }),
    }).catch(() => null);
    setSaving(false);
    const data = (await res?.json().catch(() => null)) as
      | (Choices & { publishChanged?: boolean; error?: { message?: string } })
      | null;
    if (!res?.ok || !data) {
      const message = (data?.error as { message?: string } | undefined)?.message;
      return setNotice({ kind: "error", text: message ?? "No se pudo guardar. Vuelve a intentarlo." });
    }
    setChoices(data);
    setPublishId(data.selection.publish.id);
    setBusyIds(data.selection.busy.map((c) => c.id));
    setNotice({
      kind: "ok",
      text: data.publishChanged
        ? `Calendarios guardados. Las citas que vienen se moverán a «${data.selection.publish.summary}».`
        : "Calendarios guardados.",
    });
    onSaved();
  }

  return wrap(
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor="gcal-publish" className="text-sm font-medium">Publicar las citas en</label>
        <SearchSelect
          id="gcal-publish"
          ariaLabel="Publicar las citas en"
          value={publishId}
          disabled={saving}
          searchPlaceholder="Buscar calendario…"
          options={publishable.map((c) => ({ value: c.id, label: `${c.summary}${c.primary ? " (principal)" : ""}` }))}
          onChange={(v) => {
            setNotice(null);
            setPublishId(v);
          }}
        />
        <p className="text-xs text-text-3">
          Solo aparecen los calendarios donde tu cuenta puede escribir. Al cambiarlo, las citas que vienen se mueven
          (con su enlace de Meet, sin duplicarse).
        </p>
      </div>

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Tener en cuenta lo ocupado en</legend>
        <ul className="divide-y rounded-md border">
          {choices.calendars.map((c) => {
            const id = `gcal-busy-${c.id}`;
            const checked = busyIds.includes(c.id);
            const full = !checked && busyIds.length >= MAX_BUSY_CALENDARS;
            return (
              <li key={c.id}>
                <label htmlFor={id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                  <input
                    id={id}
                    type="checkbox"
                    checked={checked}
                    disabled={saving || !c.canRead || full}
                    onChange={() => toggle(c.id)}
                    className="accent-primary"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {c.summary}
                    {c.primary ? " (principal)" : ""}
                  </span>
                  {!c.canRead && <span className="shrink-0 text-xs text-text-3">solo libre/ocupado</span>}
                </label>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-text-3">
          Hasta {MAX_BUSY_CALENDARS}. Solo cuenta si «Tener en cuenta lo ocupado en Google Calendar» está encendido.
        </p>
      </fieldset>

      {notice && (
        <p
          role="status"
          className={
            notice.kind === "ok"
              ? "rounded-sm bg-brand-tint px-3 py-2 text-sm text-brand-text"
              : "rounded-sm border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text"
          }
        >
          {notice.text}
        </p>
      )}
      <Button size="sm" onClick={() => void save()} disabled={saving || !dirty || busyIds.length === 0}>
        {saving ? "Guardando…" : "Guardar calendarios"}
      </Button>
    </div>
  );
}
