"use client";

import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { staffInviteShareText, whatsappShareUrl } from "@/lib/staff-calendar";
import { WatchLine } from "@/components/settings/watch-line";
import type { WatchStatus } from "@/lib/google-watch-status";

/**
 * Mejora 3 — El Google Calendar de UN profesional, desde Equipo (solo dueño o administrador).
 *
 *  - Sin conectar: «Generar enlace» (vence en 24 h, sirve una vez). El enlace se muestra UNA vez: se copia o
 *    se manda por WhatsApp (wa.me con su teléfono). Generar otro anula el anterior.
 *  - Conectado: cuenta, última lectura y tramos ocupados; «Leer ahora» y «Desconectar» (revoca el permiso y
 *    quita sus bloqueos).
 *  - Se perdió / falta permiso: el motivo y «Generar enlace nuevo».
 */

export type StaffCalendarRow = {
  staffId: string;
  staffName: string;
  phone: string | null;
  connection: null | {
    status: "connected" | "error";
    accountEmail: string | null;
    connectedAt: string | null;
    lastError: string | null;
    busy: {
      status: "ok" | "error" | "needs_reconnect" | null;
      syncedAt: string | null;
      error: string | null;
      blocks: number;
    };
  };
  invite: null | { expiresAt: string };
  /** Mejora 4: los avisos al instante de su calendario. */
  watch?: WatchStatus;
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es", { dateStyle: "short", timeStyle: "short" }) : "";

/** El texto corto de la columna de Equipo. */
export function staffCalendarLabel(row: StaffCalendarRow | undefined): { text: string; tone: "ok" | "warn" | "muted" } {
  if (!row) return { text: "Sin conectar", tone: "muted" };
  const c = row.connection;
  if (c && c.status === "error") return { text: "Se perdió", tone: "warn" };
  if (c && c.busy.status === "needs_reconnect") return { text: "Falta permiso", tone: "warn" };
  if (c) return { text: "Conectado", tone: "ok" };
  if (row.invite) return { text: "Enlace enviado", tone: "muted" };
  return { text: "Sin conectar", tone: "muted" };
}

export function StaffCalendarDialog({
  row,
  onClose,
  onChanged,
}: {
  row: StaffCalendarRow;
  onClose: () => void;
  /** Algo cambió en el servidor: la pantalla vuelve a pedir el estado. */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const base = `/api/negocio/equipo/${encodeURIComponent(row.staffId)}/calendario`;
  const c = row.connection;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const generate = () =>
    run(async () => {
      const out = await apiFetch<{ url: string; expiresAt: string }>(`${base}/enlace`, { method: "POST" });
      setLink(out);
      setCopied(false);
    });

  const revoke = () =>
    run(async () => {
      await apiFetch(`${base}/enlace`, { method: "DELETE" });
      setLink(null);
      setNotice("Enlace anulado.");
    });

  const readNow = () =>
    run(async () => {
      const out = await apiFetch<{ result: { outcome: string; error?: string } }>(base, { method: "POST" });
      setNotice(out.result.outcome === "synced" ? "Calendario leído." : `No se pudo leer: ${out.result.error ?? "inténtalo más tarde"}`);
    });

  const disconnect = () =>
    run(async () => {
      await apiFetch(base, { method: "DELETE" });
      setConfirmDisconnect(false);
      setNotice(`Se desconectó el Google Calendar de ${row.staffName}. Sus horarios ocupados ya no bloquean la agenda.`);
    });

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const shareText = link ? staffInviteShareText({ staffName: row.staffName, url: link.url }) : "";

  return (
    <Modal
      title={`Google Calendar de ${row.staffName}`}
      description="Lo ocupado en su calendario bloquea solo a esta persona: el resto del equipo sigue recibiendo citas. Solo se leen horarios ocupados; nada se escribe en su calendario."
      onClose={onClose}
      busy={busy}
    >
      <div className="space-y-4 text-sm">
        {c ? (
          <div className="space-y-1">
            <p>
              <span className="font-medium">
                {c.status === "error" ? "La conexión se perdió" : `Conectado${c.accountEmail ? ` como ${c.accountEmail}` : ""}`}
              </span>
            </p>
            {c.status === "error" ? (
              <p className="text-danger-text">
                Google rechazó la conexión. La agenda sigue con lo último que se leyó; genera un enlace nuevo para
                que vuelva a conectar.
              </p>
            ) : c.busy.status === "needs_reconnect" ? (
              <p className="text-danger-text">{c.busy.error ?? "Falta el permiso para leer su calendario."}</p>
            ) : c.busy.status === "error" ? (
              <p className="text-warning-text">
                No se pudo leer su calendario: {c.busy.error}. Se usa lo último que se leyó y se reintenta sola.
              </p>
            ) : c.busy.status === "ok" ? (
              <p className="text-text-3">
                Última lectura: {when(c.busy.syncedAt)} ·{" "}
                {c.busy.blocks === 1 ? "1 tramo ocupado" : `${c.busy.blocks} tramos ocupados`}
              </p>
            ) : (
              <p className="text-text-3">Leyendo su calendario…</p>
            )}
            {c.status === "connected" && <WatchLine status={row.watch ?? null} />}
          </div>
        ) : (
          <p className="text-text-2">
            {row.staffName} no ha conectado su calendario. Genera un enlace y envíaselo: lo abre en su teléfono, pulsa
            «Conectar con Google» y listo. No necesita usuario en Vocero.
          </p>
        )}

        {link ? (
          <div className="space-y-2 rounded-md border p-3">
            <p className="font-medium">Enlace para {row.staffName}</p>
            <Input readOnly value={link.url} aria-label="Enlace para conectar el calendario" onFocus={(e) => e.currentTarget.select()} />
            <p className="text-xs text-text-3">
              Vence el {when(link.expiresAt)} y sirve una sola vez. Por seguridad no se vuelve a mostrar.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void copy()}>
                {copied ? "Copiado" : "Copiar enlace"}
              </Button>
              <a
                href={whatsappShareUrl(row.phone, shareText)}
                target="_blank"
                rel="noreferrer noopener"
                className={buttonVariants({ size: "sm", variant: "secondary" })}
              >
                Enviar por WhatsApp
              </a>
            </div>
          </div>
        ) : row.invite && !c ? (
          <p className="text-text-3">
            Hay un enlace enviado que vence el {when(row.invite.expiresAt)}. Si se perdió, genera uno nuevo (el
            anterior deja de servir).
          </p>
        ) : null}

        {notice && (
          <p role="status" className="rounded-sm bg-brand-tint px-3 py-2 text-brand-text">
            {notice}
          </p>
        )}

        {confirmDisconnect && (
          <div className="space-y-2 rounded-md border border-danger-soft bg-danger-tint p-3 text-danger-text">
            <p>
              ¿Desconectar el calendario de {row.staffName}? Se revoca el permiso en Google y sus horarios ocupados
              dejan de bloquear la agenda.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => void disconnect()}>
                Sí, desconectar
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDisconnect(false)}>
                No
              </Button>
            </div>
          </div>
        )}
      </div>

      <ModalFooter error={error}>
        {c && c.status === "connected" && (
          <Button variant="secondary" disabled={busy} onClick={() => void readNow()}>
            Leer ahora
          </Button>
        )}
        {c && !confirmDisconnect && (
          <Button variant="ghost" className="text-danger-text" disabled={busy} onClick={() => setConfirmDisconnect(true)}>
            Desconectar
          </Button>
        )}
        {(row.invite || link) && !c && (
          <Button variant="ghost" disabled={busy} onClick={() => void revoke()}>
            Anular enlace
          </Button>
        )}
        {(!c || c.status === "error" || c.busy.status === "needs_reconnect") && (
          <Button disabled={busy} onClick={() => void generate()}>
            {link || row.invite || c ? "Generar enlace nuevo" : "Generar enlace (24 h)"}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}
