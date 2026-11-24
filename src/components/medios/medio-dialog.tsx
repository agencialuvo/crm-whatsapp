"use client";

import { useState } from "react";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, Download, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Modal } from "@/components/negocio/modal";
import { formatBytes, type MedioDto } from "@/lib/medios";
import { origenDeVista } from "@/lib/medios-estado";

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
  onActualizado,
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
  /** El medio cambió por otra acción (p. ej. se reencoló la optimización): el padre reemplaza la tarjeta. */
  onActualizado: (medio: MedioDto) => void;
  onDelete: () => void;
}) {
  // El borrador se reinicia al pasar a otro archivo (el padre lo remonta con `key`).
  const [nombre, setNombre] = useState(medio.nombre);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);
  const [reintentando, setReintentando] = useState(false);
  const [errorReintento, setErrorReintento] = useState<string | null>(null);

  async function reintentar() {
    setReintentando(true);
    setErrorReintento(null);
    try {
      const r = await apiFetch<{ medio: MedioDto }>(`/api/medios/${medio.id}/optimizar`, { method: "POST" });
      onActualizado(r.medio);
    } catch (err) {
      setErrorReintento(describeError(err));
    } finally {
      setReintentando(false);
    }
  }

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
              src={origenDeVista(medio)}
              controls
              playsInline
              className="max-h-[45vh] max-w-full rounded bg-black"
            />
          ) : medio.tipo === "document" ? (
            <a
              key={medio.id}
              href={medio.ruta}
              target="_blank"
              rel="noreferrer"
              className="flex h-40 w-full max-w-sm flex-col items-center justify-center gap-2 rounded border bg-subtle text-sm font-semibold underline"
            >
              <span className="text-3xl" aria-hidden>
                PDF
              </span>
              Abrir «{medio.nombre}»
            </a>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={medio.id}
              src={medio.urlFirmada ?? medio.ruta}
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

        {medio.tipo === "video" && <SeccionWhatsapp medio={medio} reintentando={reintentando} error={errorReintento} onReintentar={() => void reintentar()} />}

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

/** El estado del video para WhatsApp: qué se envía, su peso, el error legible si falló y el botón de reintento. */
function SeccionWhatsapp({
  medio,
  reintentando,
  error,
  onReintentar,
}: {
  medio: MedioDto;
  reintentando: boolean;
  error: string | null;
  onReintentar: () => void;
}) {
  const texto =
    medio.envio === "listo"
      ? `Listo para WhatsApp${medio.varianteBytes ? ` · ${formatBytes(medio.varianteBytes)}` : ""}. Se envía una versión ligera; el original no se toca.`
      : medio.envio === "optimizando"
        ? "Optimizando para WhatsApp… puede tardar unos minutos. Esta ventana se actualiza sola."
        : medio.envio === "fallo"
          ? `No se pudo optimizar el video${medio.varianteError ? `: ${medio.varianteError}` : "."}${medio.noEnviable ? "" : " Se enviará el original, que ya cabe en WhatsApp."}`
          : medio.envio === "no_enviable"
            ? "Este video no se puede enviar por WhatsApp tal cual (pesa más de 16 MB o es MOV) y no tiene versión optimizada."
            : "Se envía tal cual: ya cabe en WhatsApp.";
  const mal = medio.envio === "fallo" || medio.envio === "no_enviable";
  return (
    <section aria-label="WhatsApp" className="space-y-2 rounded-md border bg-subtle px-3 py-2.5">
      <p className="flex items-start gap-2 text-xs font-semibold text-text-2">
        {medio.envio === "optimizando" ? (
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
        ) : mal ? (
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-text" aria-hidden />
        ) : (
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <span>
          WhatsApp
          <span role="status" className={`block font-normal ${mal ? "text-danger-text" : "text-text-2"}`}>
            {texto}
          </span>
        </span>
      </p>
      {medio.puedeReintentar && (
        <Button type="button" variant="outline" onClick={onReintentar} disabled={reintentando}>
          {reintentando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          {reintentando ? "Reintentando…" : "Reintentar optimización"}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      )}
    </section>
  );
}
