"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { ConnectorCredentials } from "@/components/settings/connector-credentials";
import { GoogleCalendarPicker } from "@/components/settings/google-calendar-picker";
import { WatchLine } from "@/components/settings/watch-line";
import type { WatchStatus } from "@/lib/google-watch-status";
import { calendarLabel, oauthErrorMessage } from "@/lib/google-calendar";

/**
 * Paso 3 — Google Calendar en Ajustes → Agenda: UNA cuenta y UN calendario por negocio.
 *
 *  - «Conectar con Google» (un clic, con la app OAuth de la instancia) o, en «Avanzado», pegar las
 *    credenciales de la app propia. La conexión sirve para las dos cosas: Meet (si el conector elegido es
 *    Google) y publicar las citas en el calendario (aunque el conector sea otro).
 *  - El estado se ve siempre: conectado como…, se perdió (reconectar) o sin conectar.
 *  - «Publicar las citas en Google Calendar» y «Incluir el teléfono» se guardan al momento.
 *  - Paso 4: «Tener en cuenta lo ocupado en Google Calendar» (Google → bloqueos), con su última lectura,
 *    el aviso si falla o falta permiso, y «Leer ahora».
 *  - Mejora 2: en qué calendario se publica y cuáles se leen (`GoogleCalendarPicker`), o el aviso para
 *    reconectar si la conexión no tiene el permiso de la lista.
 */

type Connection = {
  status: "connected" | "error";
  source: "oauth" | "manual";
  accountEmail: string | null;
  lastError: string | null;
  lastOkAt: string | null;
  appMissing: boolean;
  calendarSummary?: string | null;
  fields: Record<string, string>;
};

type SyncSettings = { googleSync: boolean; googleSyncPhone: boolean; googleBusy: boolean };

/** Paso 4: la lectura de lo ocupado (null = aún sin conexión). */
type BusyState = {
  status: "ok" | "error" | "needs_reconnect" | null;
  syncedAt: string | null;
  error: string | null;
  blocks: number;
} | null;

function when(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es", { dateStyle: "short", timeStyle: "short" });
}

export function GoogleCalendarCard({
  sync,
  meetSelected,
  onSyncSaved,
}: {
  sync: SyncSettings;
  /** El conector de entrega elegido es Google (Meet). */
  meetSelected: boolean;
  onSyncSaved: (next: SyncSettings) => void;
}) {
  const [connection, setConnection] = useState<Connection | null | undefined>(undefined);
  const [oauthAvailable, setOauthAvailable] = useState(false);
  const [busyState, setBusyState] = useState<BusyState>(null);
  // Mejora 4: los avisos al instante (null = no se muestra).
  const [watch, setWatch] = useState<WatchStatus | null>(null);
  const [reading, setReading] = useState(false);
  // Mejora 3: cuántos del equipo conectaron su propio calendario (null = la instancia no lo ofrece).
  const [team, setTeam] = useState<{ connected: number; total: number } | null>(null);
  const polls = useRef(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/google").catch(() => null);
    if (!res?.ok) return setConnection(null);
    const data = (await res.json()) as {
      connection: Connection | null;
      oauthAvailable?: boolean;
      busy?: BusyState;
      watch?: WatchStatus;
    };
    setConnection(data.connection);
    setOauthAvailable(!!data.oauthAvailable);
    setBusyState(data.busy ?? null);
    setWatch(data.watch ?? null);
  }, []);

  useEffect(() => {
    void fetch("/api/negocio/equipo/calendarios")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { available?: boolean; staff?: { connection: { status: string } | null }[] } | null) => {
        if (d?.available && d.staff && d.staff.length > 0) {
          setTeam({ connected: d.staff.filter((s) => s.connection?.status === "connected").length, total: d.staff.length });
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    void load();
    // La vuelta del flujo OAuth: `?google=conectado` o `?google=error&motivo=…`. Se lee una vez y se limpia.
    const params = new URLSearchParams(window.location.search);
    const result = params.get("google");
    if (result === "conectado") setNotice({ kind: "ok", text: "Google Calendar conectado." });
    else if (result === "error") setNotice({ kind: "error", text: oauthErrorMessage(params.get("motivo")) });
    if (result) {
      params.delete("google");
      params.delete("motivo");
      const qs = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    }
  }, [load]);

  async function disconnect() {
    setBusy(true);
    setNotice(null);
    const res = await fetch("/api/settings/google", { method: "DELETE" }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return setNotice({ kind: "error", text: "No se pudo desconectar. Vuelve a intentarlo." });
    setConnection(null);
    setNotice({ kind: "ok", text: "Google Calendar desconectado. Los eventos ya publicados se quedan en tu calendario." });
  }

  async function saveSync(next: SyncSettings) {
    setBusy(true);
    setNotice(null);
    const res = await fetch("/api/calendar/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return setNotice({ kind: "error", text: "No se pudo guardar. Vuelve a intentarlo." });
    const data = (await res.json()) as { settings: SyncSettings };
    onSyncSaved({
      googleSync: data.settings.googleSync,
      googleSyncPhone: data.settings.googleSyncPhone,
      googleBusy: data.settings.googleBusy,
    });
    // Encender la lectura la lanza en el servidor; apagarla quita los bloqueos. Se refresca el estado.
    polls.current = 0;
    void load();
  }

  /** «Leer ahora»: lee Google en el momento y muestra el resultado. */
  async function readNow() {
    setReading(true);
    setNotice(null);
    const res = await fetch("/api/settings/google/busy", { method: "POST" }).catch(() => null);
    setReading(false);
    const data = (await res?.json().catch(() => null)) as
      | { busy?: BusyState; result?: { outcome: string }; error?: { message?: string } }
      | null;
    if (!res?.ok) {
      return setNotice({ kind: "error", text: data?.error?.message ?? "No se pudo leer tu calendario. Vuelve a intentarlo." });
    }
    setBusyState(data?.busy ?? null);
    if (data?.result?.outcome === "synced") setNotice({ kind: "ok", text: "Calendario leído." });
  }

  const connected = connection?.status === "connected" && !connection.appMissing;
  const connectHref = "/api/settings/google/oauth/start";

  // Recién encendida (o reconectada) la lectura corre en el servidor: se mira su resultado unas veces.
  useEffect(() => {
    if (!sync.googleBusy || !connected || busyState?.status || polls.current >= 10) return;
    const t = setTimeout(() => {
      polls.current += 1;
      void load();
    }, 1500);
    return () => clearTimeout(t);
  }, [sync.googleBusy, connected, busyState, load]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google Calendar</CardTitle>
        <CardDescription>
          Conecta una cuenta de Google para que tus citas aparezcan en su calendario
          {meetSelected ? " y cada una tenga su enlace de Meet" : ""}. Si Google falla, las citas se agendan
          igual y se publican cuando vuelva.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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

        {/* Estado de la conexión */}
        {connection === undefined ? (
          <p className="text-sm text-text-3">Cargando…</p>
        ) : connection === null ? (
          <div className="space-y-2">
            <p className="text-sm text-text-2">
              <span className="font-medium text-foreground">Sin conectar.</span>{" "}
              {oauthAvailable
                ? "Te llevamos a Google para que elijas la cuenta y des permiso a su calendario."
                : "Esta instancia no tiene la app de Google configurada: conecta con tus propias credenciales en «Avanzado»."}
            </p>
            {oauthAvailable && (
              <a href={connectHref} className={buttonVariants({})}>Conectar con Google</a>
            )}
          </div>
        ) : connected ? (
          <div className="space-y-2">
            <p className="text-sm text-text-2">
              <span className="font-medium text-foreground">
                {connection.accountEmail ? `Conectado como ${connection.accountEmail}` : "Conectado con tus credenciales"}
              </span>{" "}
              ·{" "}
              {connection.calendarSummary
                ? `publica en «${connection.calendarSummary}»`
                : calendarLabel(connection.fields.calendarId)}
            </p>
            {connection.lastError && (
              <p className="text-xs text-text-3">Último aviso de Google: {connection.lastError}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {connection.source === "oauth" && oauthAvailable && (
                <a href={connectHref} className={buttonVariants({ variant: "outline", size: "sm" })}>Cambiar de cuenta</a>
              )}
              <Button variant="ghost" size="sm" onClick={() => void disconnect()} disabled={busy}>
                Desconectar
              </Button>
            </div>
            <GoogleCalendarPicker
              reconnectHref={oauthAvailable ? connectHref : null}
              onSaved={() => {
                polls.current = 0;
                void load();
              }}
            />
          </div>
        ) : (
          <div className="space-y-2 rounded-sm border border-danger-soft bg-danger-tint p-3 text-sm text-danger-text">
            <p className="font-medium">
              {connection.appMissing
                ? "La app de Google de esta instancia ya no está configurada."
                : "La conexión con Google se perdió."}
            </p>
            <p>
              Las citas se siguen agendando, pero no se publican{meetSelected ? " ni generan enlace de Meet" : ""}{" "}
              hasta que vuelvas a conectar.
              {connection.lastError ? ` (${connection.lastError})` : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              {oauthAvailable && (
                <a href={connectHref} className={buttonVariants({ size: "sm" })}>Reconectar con Google</a>
              )}
              <Button variant="ghost" size="sm" onClick={() => void disconnect()} disabled={busy}>
                Desconectar
              </Button>
            </div>
          </div>
        )}

        {/* Publicar las citas (aparte de Meet) */}
        <div className="space-y-3 border-t pt-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Publicar las citas en Google Calendar</p>
              <p className="text-xs text-text-3">
                Cada cita crea, mueve o borra su evento, aunque no uses Meet. Sin invitados: Google no le escribe
                al cliente. Los cambios hechos en Google no vuelven a Vocero.
              </p>
            </div>
            <Switch
              checked={sync.googleSync}
              disabled={busy || (!connected && !sync.googleSync)}
              label="Publicar las citas en Google Calendar"
              onCheckedChange={(v) => void saveSync({ ...sync, googleSync: v })}
            />
          </div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Incluir el teléfono del cliente</p>
              <p className="text-xs text-text-3">
                Por privacidad, el evento solo lleva el nombre con la inicial del apellido. Actívalo si tu
                calendario no es compartido.
              </p>
            </div>
            <Switch
              checked={sync.googleSyncPhone}
              disabled={busy || !sync.googleSync}
              label="Incluir el teléfono del cliente en el evento"
              onCheckedChange={(v) => void saveSync({ ...sync, googleSyncPhone: v })}
            />
          </div>
          {!connected && !sync.googleSync && (
            <p className="text-xs text-text-3">Conecta Google para poder activarlo.</p>
          )}
        </div>

        {/* Paso 4: lo ocupado en Google bloquea la agenda (Google → Vocero) */}
        <div className="space-y-3 border-t pt-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Tener en cuenta lo ocupado en Google Calendar</p>
              <p className="text-xs text-text-3">
                Los eventos marcados «Ocupado» en tu calendario bloquean esos horarios: ni la IA ni el equipo los
                ofrecen. Se lee cada 5 minutos; lo que publica Vocero y lo marcado «Disponible» no cuentan.
              </p>
            </div>
            <Switch
              checked={sync.googleBusy}
              disabled={busy || (!connected && !sync.googleBusy)}
              label="Tener en cuenta lo ocupado en Google Calendar"
              onCheckedChange={(v) => void saveSync({ ...sync, googleBusy: v })}
            />
          </div>
          {sync.googleBusy && connection && (
            <BusyStatus
              state={busyState}
              connectionLost={!connected}
              reading={reading}
              canRead={connected}
              reconnectHref={oauthAvailable ? connectHref : null}
              onReadNow={() => void readNow()}
            />
          )}
          {sync.googleBusy && connection && <WatchLine status={watch} />}
        </div>

        {team && (
          <p className="border-t pt-4 text-xs text-text-3">
            Calendarios del equipo: {team.connected} de {team.total}{" "}
            {team.total === 1 ? "profesional conectó" : "profesionales conectaron"} su Google Calendar (lo ocupado ahí
            bloquea solo a esa persona).{" "}
            <a href="/equipo" className="font-medium text-brand-text hover:underline">Gestionar en Equipo</a>
          </p>
        )}

        {/* Avanzado: las credenciales de la app propia del negocio */}
        <details className="border-t pt-4" open={!oauthAvailable && connection === null ? true : undefined}>
          <summary className="cursor-pointer text-sm font-medium">Avanzado: usar tu propia app de Google</summary>
          <div className="mt-3">
            <ConnectorCredentials connector="google" onConnectionChange={() => void load()} />
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

/** Paso 4: cómo va la lectura de lo ocupado. La agenda nunca se cae por esto: usa lo último leído. */
function BusyStatus({
  state,
  connectionLost,
  reading,
  canRead,
  reconnectHref,
  onReadNow,
}: {
  state: BusyState;
  connectionLost: boolean;
  reading: boolean;
  canRead: boolean;
  reconnectHref: string | null;
  onReadNow: () => void;
}) {
  const last = state?.syncedAt ? ` (última lectura: ${when(state.syncedAt)})` : "";
  if (state?.status === "needs_reconnect") {
    return (
      <div className="space-y-2 rounded-sm border border-danger-soft bg-danger-tint p-3 text-sm text-danger-text">
        <p className="font-medium">Falta permiso para leer tu calendario.</p>
        <p>
          {state.error ?? "Vuelve a conectar Google y acepta el permiso del calendario."} Mientras tanto, la agenda usa
          lo último que se leyó{last}.
        </p>
        {reconnectHref && (
          <a href={reconnectHref} className={buttonVariants({ size: "sm" })}>Reconectar con Google</a>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {connectionLost ? (
        <p className="text-xs text-text-3">
          Sin conexión con Google: la agenda usa lo último que se leyó{last}. Al reconectar se vuelve a leer.
        </p>
      ) : state?.status === "error" ? (
        <p role="status" className="rounded-sm border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
          No se pudo leer tu calendario: {state.error}. La agenda usa lo último que se leyó{last} y se reintenta sola.
        </p>
      ) : state?.status === "ok" ? (
        <p className="text-xs text-text-3">
          Última lectura: {when(state.syncedAt)} ·{" "}
          {state.blocks === 1 ? "1 tramo ocupado" : `${state.blocks} tramos ocupados`} en los días que ofreces.
        </p>
      ) : (
        <p className="text-xs text-text-3">Leyendo tu calendario…</p>
      )}
      {canRead && (
        <Button variant="outline" size="sm" onClick={onReadNow} disabled={reading}>
          {reading ? "Leyendo…" : "Leer ahora"}
        </Button>
      )}
    </div>
  );
}
