"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ImagePlus, Search, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, describeError } from "@/components/negocio/api";
import { ConfirmDialog, Modal, ModalFooter } from "@/components/negocio/modal";
import { EnviosList, useImageUpload } from "@/components/medios/image-upload";
import {
  ACCEPT_ICONOS,
  ACCEPT_IMAGENES,
  formatBytes,
  resumenDeLimitesIcono,
  resumenDeLimitesImagen,
  type MedioDto,
} from "@/lib/medios";
import { cn } from "@/lib/utils";

/** La imagen elegida: su id en la biblioteca y la URL con la que se pinta. */
export type ImagenElegida = { id: string; url: string };

/** ¿Lo que se arrastra trae archivos (y no, por ejemplo, texto seleccionado)? */
function traeArchivos(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

/**
 * Campo «Imagen» de los formularios: sin imagen muestra un recuadro para
 * elegirla; con imagen, una previsualización con «Cambiar imagen» y
 * «Eliminar». La imagen sale SIEMPRE de la biblioteca de Medios (no se escribe
 * una URL a mano): se elige una existente, o se ARRASTRA una nueva sobre el
 * propio campo —se sube y queda elegida—.
 */
export function MediaImageField({
  id,
  value,
  onChange,
  disabled,
  error,
  label = "Imagen (opcional)",
  permitirSvg = false,
}: {
  id: string;
  /** El título del campo; por defecto «Imagen (opcional)». */
  label?: string;
  value: ImagenElegida | null;
  onChange: (value: ImagenElegida | null) => void;
  disabled?: boolean;
  error?: string;
  /** Admite también SVG (iconos, como el de los sellos). */
  permitirSvg?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [arrastrando, setArrastrando] = useState(false);
  const { envios, subir, descartar, subiendo } = useImageUpload((m) => onChange({ id: m.id, url: m.ruta }), { svg: permitirSvg });
  const bloqueado = disabled || subiendo;

  return (
    // Un grupo con su título: la etiqueta NO se asocia al botón (si lo estuviera,
    // su nombre accesible pasaría a ser «Imagen (opcional)» y no «Elegir imagen»).
    <div className="space-y-1.5" role="group" aria-labelledby={`${id}-titulo`}>
      <Label id={`${id}-titulo`}>{label}</Label>
      <div
        className="relative"
        onDragEnter={(e) => {
          if (!bloqueado && traeArchivos(e)) setArrastrando(true);
        }}
        onDragOver={(e) => {
          if (!bloqueado && traeArchivos(e)) e.preventDefault();
        }}
        onDragLeave={(e) => {
          // Pasar de un hijo a otro no es salir del campo.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setArrastrando(false);
        }}
        onDrop={(e) => {
          if (bloqueado || !traeArchivos(e)) return;
          e.preventDefault();
          setArrastrando(false);
          void subir(Array.from(e.dataTransfer.files));
        }}
      >
        {value ? (
          <div className="overflow-hidden rounded-md border bg-subtle">
            <div className="flex aspect-[16/9] items-center justify-center bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={value.url} alt="Imagen elegida" className="h-full w-full object-cover" />
            </div>
            <div className="flex flex-wrap items-center gap-2 p-2">
              <Button
                id={id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setOpen(true)}
                disabled={bloqueado}
              >
                <ImagePlus className="h-4 w-4" aria-hidden />
                Cambiar imagen
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange(null)}
                disabled={bloqueado}
                className="text-danger-text hover:text-danger-text"
              >
                <X className="h-4 w-4" aria-hidden />
                Eliminar
              </Button>
              <span className="text-xs text-text-3">o arrastra otra imagen aquí</span>
            </div>
          </div>
        ) : (
          <button
            id={id}
            type="button"
            onClick={() => setOpen(true)}
            disabled={bloqueado}
            className={cn(
              "flex w-full flex-col items-center gap-1 rounded-md border border-dashed px-4 py-5 text-sm text-text-2 transition-colors",
              "hover:border-brand hover:bg-brand-tint hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
              error && "border-danger"
            )}
          >
            <ImagePlus className="h-6 w-6" strokeWidth={1.6} aria-hidden />
            <span className="font-semibold">Elegir imagen</span>
            <span className="text-xs text-text-3">De tu biblioteca o arrastra una nueva aquí</span>
          </button>
        )}

        {arrastrando && (
          <div
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-brand bg-brand-tint"
            aria-hidden
          >
            <p className="flex items-center gap-2 text-sm font-semibold text-brand">
              <Upload className="h-5 w-5" /> Suelta la imagen para subirla
            </p>
          </div>
        )}
      </div>

      <p className="text-xs text-text-3">{permitirSvg ? resumenDeLimitesIcono() : resumenDeLimitesImagen()}</p>
      <EnviosList envios={envios} onDismiss={descartar} />
      {error && (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      )}
      {open &&
        createPortal(
          <MediaPickerDialog
            selectedId={value?.id ?? null}
            permitirSvg={permitirSvg}
            onClose={() => setOpen(false)}
            // Borrada de la galería = ya no existe: la previsualización se quita al instante.
            onDeleted={(borrada) => {
              if (value?.id === borrada) onChange(null);
            }}
            onPick={(m) => {
              onChange({ id: m.id, url: m.ruta });
              setOpen(false);
            }}
          />,
          document.body
        )}
    </div>
  );
}

/**
 * La galería en una ventana: las imágenes de la biblioteca para elegir una (un
 * clic la elige; otro clic sobre la misma, la quita) y una zona para subir otra
 * sin salir del formulario: con el botón, arrastrando o pegando (Ctrl+V). Solo
 * imágenes, con los mismos límites de peso que Medios.
 */
function MediaPickerDialog({
  selectedId,
  onPick,
  onClose,
  onDeleted,
  permitirSvg = false,
}: {
  selectedId: string | null;
  permitirSvg?: boolean;
  onPick: (medio: MedioDto) => void;
  onClose: () => void;
  /** Se borró una imagen de la galería (para que quien la usa se entere). */
  onDeleted?: (id: string) => void;
}) {
  const [items, setItems] = useState<MedioDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(selectedId);
  const [exito, setExito] = useState<string | null>(null);
  const [arrastrando, setArrastrando] = useState(false);
  const [query, setQuery] = useState("");
  const [borrando, setBorrando] = useState<MedioDto | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // En pantallas táctiles no hay arrastrar ni Ctrl+V: el texto habla de la galería.
  const [esCelular, setEsCelular] = useState(false);
  useEffect(() => {
    setEsCelular(window.matchMedia("(pointer: coarse)").matches);
  }, []);

  const { envios, subir, descartar, subiendo } = useImageUpload((medio) => {
    setItems((prev) => [medio, ...(prev ?? [])]);
    // Lo recién subido es lo que se quiere usar.
    setSelected(medio.id);
    setExito(`«${medio.nombre}» se subió y quedó seleccionada.`);
  }, { svg: permitirSvg });

  const cargar = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await apiFetch<{ medios: MedioDto[] }>("/api/medios?tipo=image");
      setItems(r.medios);
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // Pegar una imagen del portapapeles (una captura, «Copiar imagen» en la web).
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const archivos = Array.from(e.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith("image/")
      );
      if (archivos.length === 0) return;
      e.preventDefault();
      setExito(null);
      void subir(archivos);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [subir]);

  const elegido = items?.find((m) => m.id === selected) ?? null;

  // Búsqueda por nombre, en vivo; sin tildes ni mayúsculas («peluquero» encuentra «Peluquero»).
  const fold = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const q = fold(query.trim());
  const visibles = q ? (items ?? []).filter((m) => fold(m.nombre).includes(q)) : (items ?? []);

  async function borrar(m: MedioDto) {
    await apiFetch(`/api/medios/${m.id}`, { method: "DELETE" });
    // Se refleja al instante: en la galería, en la selección y en el formulario.
    setItems((prev) => (prev ?? []).filter((x) => x.id !== m.id));
    setSelected((cur) => (cur === m.id ? null : cur));
    setExito(null);
    onDeleted?.(m.id);
  }

  return (
    <Modal
      title="Elegir imagen"
      description="Haz clic en una imagen de la galería para elegirla, o sube una nueva."
      onClose={onClose}
      busy={subiendo}
      size="lg"
    >
      <div
        className="relative"
        onDragEnter={(e) => {
          if (traeArchivos(e)) setArrastrando(true);
        }}
        onDragOver={(e) => {
          if (traeArchivos(e)) e.preventDefault();
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setArrastrando(false);
        }}
        onDrop={(e) => {
          if (!traeArchivos(e)) return;
          e.preventDefault();
          setArrastrando(false);
          setExito(null);
          void subir(Array.from(e.dataTransfer.files));
        }}
      >
        {/* Subir una nueva. TODA la zona es el botón: un clic dispara por código el
            <input type="file"> oculto (más abajo). En el ordenador abre el explorador
            de archivos; en el celular, el selector nativo (galería de fotos,
            cámara o archivos). El filtro `accept` deja elegir solo imágenes JPG,
            PNG, WEBP o AVIF desde el principio. */}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={subiendo}
          className={cn(
            "mb-4 flex w-full flex-col items-center gap-1.5 rounded-md border border-dashed px-4 py-5 text-center transition-colors",
            "hover:border-brand hover:bg-brand-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          )}
        >
          <Upload className="h-6 w-6 text-brand" strokeWidth={1.6} aria-hidden />
          <span className="text-sm font-semibold">Subir imagen nueva</span>
          <span className="text-xs text-text-2">
            Toca o haz clic para buscarla en tu {esCelular ? "galería o archivos" : "equipo"}
            {esCelular ? "" : <>, arrástrala aquí o pégala con{" "}
            <kbd className="rounded border bg-subtle px-1">Ctrl</kbd> +{" "}
            <kbd className="rounded border bg-subtle px-1">V</kbd></>}
          </span>
          <span className="text-xs text-text-3">{permitirSvg ? resumenDeLimitesIcono() : resumenDeLimitesImagen()}</span>
        </button>
        {/* El input real, oculto: solo lo activa el botón de arriba. Sin `capture`:
            eso forzaría la cámara y quitaría la galería. */}
        <input
          ref={inputRef}
          type="file"
          accept={permitirSvg ? ACCEPT_ICONOS : ACCEPT_IMAGENES}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const archivos = Array.from(e.target.files ?? []);
            e.target.value = ""; // permite volver a elegir la misma imagen
            setExito(null);
            void subir(archivos);
          }}
        />

        <EnviosList envios={envios} onDismiss={descartar} className="mb-3" />
        {exito && !subiendo && (
          <p
            role="status"
            className="mb-3 flex items-center gap-2 rounded-md border border-success-soft bg-success-tint px-3 py-2 text-sm text-success-text"
          >
            <Check className="h-4 w-4 shrink-0" aria-hidden />
            {exito}
          </p>
        )}

        {/* La galería */}
        {items && items.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">
              Galería <span className="font-normal text-text-3">({items.length})</span>
            </p>
            {elegido ? (
              <div className="flex items-center gap-2 text-xs text-text-3">
                <span className="max-w-[16rem] truncate">Elegida: «{elegido.nombre}»</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSelected(null);
                    setExito(null);
                  }}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                  Quitar selección
                </Button>
              </div>
            ) : (
              <p className="text-xs text-text-3">Ninguna elegida</p>
            )}
          </div>
        )}
        {items && items.length > 0 && (
          <div className="relative mb-3">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3"
              aria-hidden
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // Enter en el buscador no debe enviar el formulario que está detrás.
              onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
              placeholder="Buscar imagen por nombre"
              aria-label="Buscar imagen por nombre"
              autoComplete="off"
              className="pl-8"
            />
          </div>
        )}

        {loadError ? (
          <div role="alert" className="rounded-md border border-danger-soft bg-danger-tint p-3 text-sm text-danger-text">
            <p>{loadError}</p>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void cargar()}>
              Reintentar
            </Button>
          </div>
        ) : items === null ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-busy="true" aria-label="Cargando imágenes">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="aspect-square animate-pulse rounded-md bg-subtle" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-text-3">
            Tu galería aún no tiene imágenes. Sube la primera arrastrándola aquí o con «Subir imagen nueva».
          </p>
        ) : visibles.length === 0 ? (
          <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-text-3">
            Ninguna imagen coincide con «{query.trim()}».
          </p>
        ) : (
          <>
            <ul className="grid max-h-[36vh] grid-cols-3 gap-2 overflow-y-auto p-1 sm:grid-cols-4">
              {visibles.map((m) => {
                const activo = m.id === selected;
                return (
                  <li key={m.id} className="group/tile relative">
                    <button
                      type="button"
                      aria-pressed={activo}
                      aria-label={`${activo ? "Quitar la selección de" : "Elegir"} ${m.nombre}`}
                      title={`${m.nombre} · ${formatBytes(m.bytes)}${activo ? " — clic para quitar la selección" : ""}`}
                      // Un clic elige; otro clic sobre la misma la quita.
                      onClick={() => {
                        setSelected(activo ? null : m.id);
                        setExito(null);
                      }}
                      onDoubleClick={() => onPick(m)}
                      className={cn(
                        "group relative block aspect-square w-full overflow-hidden rounded-md border bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        activo && "ring-2 ring-brand ring-offset-2 ring-offset-background"
                      )}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={m.ruta} alt="" loading="lazy" className="h-full w-full object-cover" />
                      {activo && (
                        <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-brand text-brand-fg">
                          <Check className="h-3.5 w-3.5 group-hover:hidden" aria-hidden />
                          <X className="hidden h-3.5 w-3.5 group-hover:block" aria-hidden />
                        </span>
                      )}
                    </button>
                    {/* Hermano del botón de elegir (un botón dentro de otro no es válido).
                        En pantallas táctiles no hay «pasar el cursor»: ahí siempre se ve. */}
                    <button
                      type="button"
                      aria-label={`Borrar ${m.nombre} de la galería`}
                      title="Borrar de la galería"
                      onClick={() => setBorrando(m)}
                      className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/65 text-white opacity-100 transition-opacity hover:bg-danger focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:opacity-0 sm:group-hover/tile:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-xs text-text-3">
              Un clic elige la imagen; otro clic sobre la misma le quita la selección.
              {q && ` Mostrando ${visibles.length} de ${items?.length ?? 0}.`}
            </p>
          </>
        )}

        {arrastrando && (
          <div
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-brand bg-brand-tint"
            aria-hidden
          >
            <p className="flex items-center gap-2 text-sm font-semibold text-brand">
              <Upload className="h-5 w-5" /> Suelta la imagen para subirla
            </p>
          </div>
        )}
      </div>

      <ModalFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={subiendo}>
          Cancelar
        </Button>
        <Button type="button" onClick={() => elegido && onPick(elegido)} disabled={!elegido || subiendo}>
          Usar esta imagen
        </Button>
      </ModalFooter>

      {borrando &&
        createPortal(
          <ConfirmDialog
            title="Borrar imagen"
            message={
              <>
                Se borrará <strong>«{borrando.nombre}»</strong> de la galería. Los servicios y ofertas
                que la usan se quedarán sin imagen. No se puede deshacer.
              </>
            }
            confirmLabel="Borrar"
            onConfirm={() => borrar(borrando)}
            onClose={() => setBorrando(null)}
          />,
          document.body
        )}
    </Modal>
  );
}
