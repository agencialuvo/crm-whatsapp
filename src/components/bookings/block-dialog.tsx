"use client";

import { useEffect, useState } from "react";
import { blockStartUtc } from "@/lib/time/calendar";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogCloseButton } from "@/components/ui/dialog-close";
import { SearchSelect } from "@/components/ui/search-select";

/**
 * 215 — Bloquear un horario: para compromisos que viven fuera del CRM. Ese
 * tiempo deja de ofrecerse. Se abre desde la barra o tocando un hueco vacío de
 * la rejilla, ya con ese día y esa hora.
 */

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 600];

function durationLabel(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function BlockDialog({
  initialDay,
  initialTime,
  timezone,
  onCancel,
  onCreated,
}: {
  initialDay: string;
  initialTime: string;
  timezone: string;
  onCancel: () => void;
  onCreated: (day: string) => void;
}) {
  const [day, setDay] = useState(initialDay);
  const [time, setTime] = useState(initialTime);
  const [minutes, setMinutes] = useState(60);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // El día y la hora son del NEGOCIO, no del navegador (antes, `new Date()`
    // sobre un datetime-local bloqueaba la hora del reloj de quien miraba).
    const startUtc = blockStartUtc(day, time, timezone);
    if (!startUtc) {
      setError("Esa hora no existe en la zona del negocio");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "block",
        startUtc,
        durationMinutes: minutes,
        notes: notes.trim() || null,
      }),
    }).catch(() => null);
    setBusy(false);
    if (res?.status !== 201) {
      const data = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(data?.error?.message ?? "No se pudo bloquear ese horario");
      return;
    }
    onCreated(day);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bloquear-titulo"
      onClick={onCancel}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-sm space-y-4 rounded-lg border bg-popover p-5 shadow-pop"
      >
        <DialogCloseButton onClick={onCancel} />
        <div className="pr-8">
          <h3 id="bloquear-titulo" className="text-[16px] font-bold">
            Bloquear horario
          </h3>
          <p className="mt-1 text-sm text-text-3">
            Para compromisos que viven fuera del CRM: ese tiempo deja de ofrecerse.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="bloqueo-dia" required>Día</Label>
            <DatePicker id="bloqueo-dia" value={day} onChange={setDay} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bloqueo-hora" required>Hora</Label>
            <Input
              id="bloqueo-hora"
              type="time"
              required
              step={300}
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="bloqueo-duracion" required>Duración</Label>
          <SearchSelect
            id="bloqueo-duracion"
            value={String(minutes)}
            onChange={(v) => setMinutes(Number(v))}
            options={DURATIONS.map((d) => ({ value: String(d), label: durationLabel(d) }))}
            searchPlaceholder="Buscar duración…"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="bloqueo-nota">Motivo (opcional)</Label>
          <Input
            id="bloqueo-nota"
            value={notes}
            maxLength={120}
            placeholder="Comida con proveedor"
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <p className="text-xs text-text-3">Hora de la zona del negocio ({timezone}).</p>

        {error && (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || !day || !time}>
            {busy ? "Bloqueando…" : "Bloquear"}
          </Button>
        </div>
      </form>
    </div>
  );
}
