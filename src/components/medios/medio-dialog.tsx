"use client";

import { useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Modal } from "@/components/negocio/modal";
import { formatBytes, type MedioDto } from "@/lib/medios";

/**
 * Módulo Medios — vista de un archivo en una ventana compacta y centrada: la
 * imagen o el video a un tamaño cómodo (sin tapar la pantalla), su nombre
 * editable y las acciones de descargar y borrar. Se cierra con la X, Escape o
 * tocando fuera.
 */
export function MedioDialog({
  medio,
  hayAnterior,
  haySiguiente,
  onClose,
  onPrev,
  onNext,
  copiado,
  onCopy,
  onRenamed,
  onDelete,
}: {
  medio: MedioDto;
  hayAnterior: boolean;
  haySiguiente: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** «URL copiada» reciente: el botón lo confirma un momento. */
  copiado: boolean;
  onCopy: () => void;
  onRenamed: (medio: MedioDto) => void;
  onDelete: () => void;
}) {
  // El borrador se reinicia al pasar a otro archivo (el padre lo remonta con `key`).
  const [nombre, setNombre] = useState(medio.nombre);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  const limpio = nombre.replace(/\s+/g, " ").trim();
  const cambio = limpio !== medio.nombre;

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (!cambio) return;
    if (!limpio) {
      setError("Escribe un nombre.");
      return;
    }
    setBusy(true);
    setError(null);
    setGuardado(false);
    try {
      const r = await apiFetch<{ medio: MedioDto }>(`/api/medios/${medio.id}`, {
        method: "PATCH",
        json: { nombre: limpio },
      });
      onRenamed(r.medio);
      setNombre(r.medio.nombre);
      setGuardado(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const fecha = new Date(medio.creadoEn).toLocaleDateString("es", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <Modal
      title={medio.tipo === "video" ? "Video" : "Imagen"}
      description={`${medio.mime.split("/")[1]?.toUpperCase()} · ${formatBytes(medio.bytes)} · ${fecha}`}
      onClose={onClose}
      busy={busy}
    >
      <div className="space-y-4">
        <div className="relative flex items-center justify-center rounded-md border bg-muted p-2">
          {hayAnterior && (
            <button
              type="button"
              onClick={onPrev}
              aria-label="Anterior"
              className="absolute left-1.5 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <ChevronLeft className="h-5 w-5" aria-hidden />
            </button>
          )}
          {medio.tipo === "video" ? (
            <video
              key={medio.id}
              src={medio.ruta}
              controls
              playsInline
              className="max-h-[45vh] max-w-full rounded bg-black"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={medio.id}
              src={medio.ruta}
              alt={medio.nombre}
              className="max-h-[45vh] max-w-full rounded object-contain"
            />
          )}
          {haySiguiente && (
            <button
              type="button"
              onClick={onNext}
              aria-label="Siguiente"
              className="absolute right-1.5 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <ChevronRight className="h-5 w-5" aria-hidden />
            </button>
          )}
        </div>

        <form onSubmit={(e) => void guardar(e)} noValidate className="space-y-1.5">
          <Label htmlFor="medio-nombre" required>Nombre</Label>
          <div className="flex items-start gap-2">
            <Input
              id="medio-nombre"
              value={nombre}
              maxLength={120}
              autoComplete="off"
              onChange={(e) => {
                setNombre(e.target.value);
                setGuardado(false);
                setError(null);
              }}
              disabled={busy}
              aria-invalid={!!error}
            />
            <Button type="submit" variant="outline" disabled={busy || !cambio}>
              {busy ? "Guardando…" : "Guardar"}
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-xs text-danger-text">
              {error}
            </p>
          )}
          {guardado && !error && (
            <p role="status" className="text-xs text-text-2">
              Nombre guardado.
            </p>
          )}
        </form>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={onCopy} disabled={busy}>
              {copiado ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
              {copiado ? "¡URL copiada!" : "Copiar URL"}
            </Button>
            <a
              href={`${medio.ruta}?descargar=1`}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Download className="h-4 w-4" aria-hidden />
              Descargar
            </a>
          </div>
          <Button
            type="button"
            variant="outline"
            className="text-danger-text"
            onClick={onDelete}
            disabled={busy}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            Borrar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
