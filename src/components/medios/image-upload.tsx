"use client";

import { useCallback, useRef, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { subirArchivo } from "@/components/medios/upload";
import { validarMedio, type MedioDto } from "@/lib/medios";
import { cn } from "@/lib/utils";

/** Un archivo en camino: subiéndose, o rechazado (antes o después de enviarlo). */
export type Envio = {
  key: string;
  nombre: string;
  estado: "subiendo" | "error";
  progreso: number;
  error?: string;
};

/**
 * Subir imágenes a la biblioteca desde un formulario: valida formato y peso
 * ANTES de enviar (y dice por qué se rechaza), solo admite imágenes —un video no
 * sirve como foto de un servicio—, sube de a una con el avance real y avisa a
 * quien la usa con cada imagen subida. Lo comparten el campo «Imagen» (que
 * acepta arrastrar encima) y la ventana de la galería (que además acepta pegar).
 */
export function useImageUpload(onUploaded: (medio: MedioDto) => void, opts: { svg?: boolean } = {}) {
  const svg = opts.svg === true;
  const [envios, setEnvios] = useState<Envio[]>([]);
  const contador = useRef(0);
  // El que llama puede cambiar de función en cada render; se usa siempre la última.
  const alSubir = useRef(onUploaded);
  alSubir.current = onUploaded;

  const subir = useCallback(async (archivos: File[]) => {
    if (archivos.length === 0) return;
    const lote = archivos.map((file) => {
      contador.current += 1;
      const v = validarMedio(file.name, file.type, file.size, { svg });
      return { file, key: `up-${contador.current}`, v, esVideo: v.ok && v.formato.tipo === "video" };
    });
    setEnvios((prev) => [
      ...prev,
      ...lote.map(({ file, key, v, esVideo }): Envio => {
        if (!v.ok) return { key, nombre: file.name, estado: "error", progreso: 0, error: v.message };
        if (esVideo) {
          return {
            key,
            nombre: file.name,
            estado: "error",
            progreso: 0,
            error: `«${file.name}» es un video. Aquí solo se aceptan imágenes (JPG, PNG, WEBP o AVIF).`,
          };
        }
        return { key, nombre: file.name, estado: "subiendo", progreso: 0 };
      }),
    ]);

    for (const { file, key, v, esVideo } of lote) {
      if (!v.ok || esVideo) continue;
      try {
        const medio = await subirArchivo(
          file,
          (f) => setEnvios((prev) => prev.map((e) => (e.key === key ? { ...e, progreso: f } : e))),
          // El servidor también lo exige: la pantalla sola no es una barrera.
          "image",
          svg
        );
        setEnvios((prev) => prev.filter((e) => e.key !== key));
        alSubir.current(medio);
      } catch (err) {
        const mensaje = err instanceof Error ? err.message : "No se pudo subir el archivo.";
        setEnvios((prev) =>
          prev.map((e) => (e.key === key ? { ...e, estado: "error", error: mensaje } : e))
        );
      }
    }
  }, [svg]);

  const descartar = useCallback(
    (key: string) => setEnvios((prev) => prev.filter((e) => e.key !== key)),
    []
  );

  return { envios, subir, descartar, subiendo: envios.some((e) => e.estado === "subiendo") };
}

/** El avance de lo que se sube y los avisos de lo que se rechazó. */
export function EnviosList({
  envios,
  onDismiss,
  className,
}: {
  envios: Envio[];
  onDismiss: (key: string) => void;
  className?: string;
}) {
  if (envios.length === 0) return null;
  return (
    <ul className={cn("space-y-2", className)} aria-live="polite">
      {envios.map((e) => (
        <li
          key={e.key}
          role={e.estado === "error" ? "alert" : undefined}
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
            e.estado === "error"
              ? "border-danger-soft bg-danger-tint text-danger-text"
              : "bg-subtle text-text-2"
          )}
        >
          {e.estado === "error" ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            {e.estado === "error" ? (
              <p>{e.error}</p>
            ) : (
              <>
                <p className="truncate">
                  Subiendo «{e.nombre}»… {Math.round(e.progreso * 100)} %
                </p>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-brand transition-[width]"
                    style={{ width: `${Math.round(e.progreso * 100)}%` }}
                  />
                </div>
              </>
            )}
          </div>
          {e.estado === "error" && (
            <button
              type="button"
              aria-label="Descartar aviso"
              onClick={() => onDismiss(e.key)}
              className="rounded-sm p-0.5 hover:bg-danger-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
