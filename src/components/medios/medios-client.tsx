"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, ImageIcon, Loader2, Play, Search, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { apiFetch, describeError } from "@/components/negocio/api";
import { ConfirmDialog } from "@/components/negocio/modal";
import { absoluteMediaUrl, copyText } from "@/components/medios/copy-url";
import { MedioDialog } from "@/components/medios/medio-dialog";
import { subirArchivo } from "@/components/medios/upload";
import {
  ACCEPT_MEDIOS,
  formatBytes,
  resumenDeLimites,
  validarMedio,
  type MedioDto,
} from "@/lib/medios";
import { cn } from "@/lib/utils";

type Filtro = "todos" | "image" | "video";

/** Un archivo en camino: subiéndose, o rechazado (antes o después de enviarlo). */
type Envio = {
  key: string;
  nombre: string;
  estado: "subiendo" | "error";
  progreso: number;
  error?: string;
};

/**
 * Módulo Medios — la biblioteca de imágenes y videos, al estilo de WordPress:
 * una cuadrícula, subida desde el dispositivo (también arrastrando), vista
 * compacta con el nombre editable, borrado rápido al pasar el cursor y
 * selección múltiple para borrar varios a la vez.
 */
export function MediosClient() {
  const [medios, setMedios] = useState<MedioDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [busqueda, setBusqueda] = useState("");
  const [envios, setEnvios] = useState<Envio[]>([]);
  const [arrastrando, setArrastrando] = useState(false);
  const [viendo, setViendo] = useState<string | null>(null);
  // Lo que se va a borrar (uno o varios) y espera confirmación.
  const [borrando, setBorrando] = useState<MedioDto[] | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const contador = useRef(0);
  // Aviso de «URL copiada» (tarjeta o ventana), que se apaga solo.
  const [copiado, setCopiado] = useState<string | null>(null);
  const copiadoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cargar = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await apiFetch<{ medios: MedioDto[] }>("/api/medios");
      setMedios(r.medios);
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void cargar();
    return () => {
      if (copiadoTimer.current) clearTimeout(copiadoTimer.current);
    };
  }, [cargar]);

  async function copiar(m: MedioDto) {
    const ok = await copyText(absoluteMediaUrl(m.ruta));
    if (!ok) {
      setEnvios((e) => [
        ...e,
        {
          key: `copy-${Date.now()}`,
          nombre: m.nombre,
          estado: "error",
          progreso: 0,
          error: "Tu navegador no dejó copiar la URL. Inténtalo de nuevo o usa otro navegador.",
        },
      ]);
      return;
    }
    setCopiado(m.id);
    if (copiadoTimer.current) clearTimeout(copiadoTimer.current);
    copiadoTimer.current = setTimeout(() => setCopiado(null), 2000);
  }

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return (medios ?? []).filter(
      (m) => (filtro === "todos" || m.tipo === filtro) && (!q || m.nombre.toLowerCase().includes(q))
    );
  }, [medios, filtro, busqueda]);

  const subir = useCallback(async (archivos: File[]) => {
    if (archivos.length === 0) return;
    // Se validan todos primero y se enseñan de golpe: un rechazado no frena a los demás.
    const lote = archivos.map((file) => {
      contador.current += 1;
      return { file, key: `up-${contador.current}`, v: validarMedio(file.name, file.type, file.size) };
    });
    setEnvios((prev) => [
      ...prev,
      ...lote.map(({ file, key, v }): Envio =>
        v.ok
          ? { key, nombre: file.name, estado: "subiendo", progreso: 0 }
          : { key, nombre: file.name, estado: "error", progreso: 0, error: v.message }
      ),
    ]);

    for (const { file, key, v } of lote) {
      if (!v.ok) continue;
      try {
        const medio = await subirArchivo(file, (f) =>
          setEnvios((prev) => prev.map((e) => (e.key === key ? { ...e, progreso: f } : e)))
        );
        setMedios((prev) => [medio, ...(prev ?? [])]);
        setEnvios((prev) => prev.filter((e) => e.key !== key));
      } catch (err) {
        const mensaje = err instanceof Error ? err.message : "No se pudo subir el archivo.";
        setEnvios((prev) =>
          prev.map((e) => (e.key === key ? { ...e, estado: "error", error: mensaje } : e))
        );
      }
    }
  }, []);

  function alElegir(e: React.ChangeEvent<HTMLInputElement>) {
    const archivos = Array.from(e.target.files ?? []);
    e.target.value = ""; // permite volver a elegir el mismo archivo
    void subir(archivos);
  }

  function alSoltar(e: React.DragEvent) {
    e.preventDefault();
    setArrastrando(false);
    void subir(Array.from(e.dataTransfer.files));
  }

  /** Borra uno o varios (lo que se confirmó) y avisa de los que no se pudieron borrar. */
  async function borrar(lista: MedioDto[]) {
    const r = await apiFetch<{ borrados: string[]; omitidos: { id: string; motivo: string }[] }>(
      "/api/medios/eliminar",
      { method: "POST", json: { ids: lista.map((m) => m.id) } }
    );
    const fuera = new Set(r.borrados);
    setMedios((prev) => (prev ?? []).filter((x) => !fuera.has(x.id)));
    setSeleccion((prev) => new Set([...prev].filter((id) => !fuera.has(id))));
    setViendo(null);
    if (r.omitidos.length > 0) {
      const nombre = (id: string) => lista.find((m) => m.id === id)?.nombre ?? "archivo";
      setEnvios((prev) => [
        ...prev,
        ...r.omitidos.map((o, i): Envio => ({
          key: `del-${Date.now()}-${i}`,
          nombre: nombre(o.id),
          estado: "error",
          progreso: 0,
          error: `«${nombre(o.id)}»: ${o.motivo}`,
        })),
      ]);
    }
  }

  function alternar(id: string) {
    setSeleccion((prev) => {
      const sig = new Set(prev);
      if (sig.has(id)) sig.delete(id);
      else sig.add(id);
      return sig;
    });
  }

  const indiceViendo = viendo ? visibles.findIndex((m) => m.id === viendo) : -1;
  const medioViendo = indiceViendo >= 0 ? visibles[indiceViendo] : undefined;
  const marcados = (medios ?? []).filter((m) => seleccion.has(m.id));
  const todosMarcados = visibles.length > 0 && visibles.every((m) => seleccion.has(m.id));
  const subiendo = envios.some((e) => e.estado === "subiendo");
  const errores = envios.filter((e) => e.estado === "error");

  return (
    <div
      className="relative min-h-full"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files")) setArrastrando(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDragLeave={(e) => {
        // Solo al salir de la zona entera, no al pasar sobre un hijo.
        if (e.currentTarget === e.target) setArrastrando(false);
      }}
      onDrop={alSoltar}
    >
      {/* Barra de acciones */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => inputRef.current?.click()}>
          <Upload className="h-4 w-4" aria-hidden />
          Subir archivos
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT_MEDIOS}
          className="sr-only"
          tabIndex={-1}
          aria-label="Elegir archivos para subir"
          onChange={alElegir}
        />

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Filtrar por tipo" className="flex rounded-full border p-0.5">
            {(
              [
                ["todos", "Todos"],
                ["image", "Imágenes"],
                ["video", "Videos"],
              ] as const
            ).map(([valor, etiqueta]) => (
              <button
                key={valor}
                type="button"
                aria-pressed={filtro === valor}
                onClick={() => setFiltro(valor)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  filtro === valor ? "bg-brand text-brand-fg" : "text-text-2 hover:bg-accent"
                )}
              >
                {etiqueta}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />
            <Input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por nombre"
              aria-label="Buscar por nombre"
              className="w-44 pl-8 sm:w-56"
            />
          </div>
        </div>
      </div>

      <p className="mb-4 text-xs text-text-3">{resumenDeLimites()}. También puedes arrastrar archivos aquí.</p>

      {/* Selección múltiple */}
      {marcados.length > 0 && (
        <div
          role="region"
          aria-label="Acciones para los archivos seleccionados"
          className="mb-4 flex flex-wrap items-center gap-2 rounded-md border bg-subtle px-3 py-2 text-sm"
        >
          <span className="font-semibold">
            {marcados.length} seleccionado{marcados.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={() =>
              setSeleccion(todosMarcados ? new Set() : new Set(visibles.map((m) => m.id)))
            }
            className="text-xs font-semibold text-text-2 underline hover:text-foreground"
          >
            {todosMarcados ? "Quitar la selección" : "Seleccionar todos los visibles"}
          </button>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setSeleccion(new Set())}>
              Cancelar
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-danger-text"
              onClick={() => setBorrando(marcados)}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              Eliminar seleccionados
            </Button>
          </div>
        </div>
      )}

      {/* Envíos en curso y rechazados */}
      {envios.length > 0 && (
        <ul className="mb-4 space-y-2" aria-live="polite">
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
                  onClick={() => setEnvios((prev) => prev.filter((x) => x.key !== e.key))}
                  className="rounded-sm p-0.5 hover:bg-danger-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              )}
            </li>
          ))}
          {errores.length > 1 && !subiendo && (
            <li>
              <button
                type="button"
                onClick={() => setEnvios((prev) => prev.filter((x) => x.estado !== "error"))}
                className="text-xs font-semibold text-text-3 underline hover:text-foreground"
              >
                Descartar todos los avisos
              </button>
            </li>
          )}
        </ul>
      )}

      {/* Contenido */}
      {loadError ? (
        <div role="alert" className="rounded-md border border-danger-soft bg-danger-tint p-4 text-sm text-danger-text">
          <p>{loadError}</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void cargar()}>
            Reintentar
          </Button>
        </div>
      ) : medios === null ? (
        <div
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
          aria-busy="true"
          aria-label="Cargando medios"
        >
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-md bg-subtle" />
          ))}
        </div>
      ) : medios.length === 0 ? (
        <EmptyState
          icon={ImageIcon}
          title="Aún no hay archivos"
          description="Sube imágenes y videos desde tu dispositivo para guardarlos aquí y usarlos en tus servicios y ofertas."
          className="rounded-lg border border-dashed py-14"
          action={
            <Button type="button" onClick={() => inputRef.current?.click()}>
              <Upload className="h-4 w-4" aria-hidden />
              Subir archivos
            </Button>
          }
        />
      ) : visibles.length === 0 ? (
        <EmptyState
          icon={Search}
          title="Nada coincide"
          description="Ningún archivo cumple el filtro o la búsqueda actual."
          className="py-14"
        />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {visibles.map((m) => (
            <li key={m.id} className="group relative">
              <button
                type="button"
                onClick={() => setViendo(m.id)}
                aria-label={`Ver ${m.nombre}`}
                className={cn(
                  "block w-full overflow-hidden rounded-md border bg-subtle text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  seleccion.has(m.id) && "ring-2 ring-brand"
                )}
              >
                <span className="relative block aspect-square bg-muted">
                  {m.tipo === "video" ? (
                    <>
                      {/* #t=0.1: pinta un fotograma como miniatura sin reproducir. */}
                      <video
                        src={`${m.ruta}#t=0.1`}
                        preload="metadata"
                        muted
                        playsInline
                        tabIndex={-1}
                        className="h-full w-full object-cover"
                      />
                      <span className="absolute inset-0 flex items-center justify-center">
                        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white">
                          <Play className="h-5 w-5 translate-x-px" aria-hidden />
                        </span>
                      </span>
                    </>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.ruta} alt="" loading="lazy" className="h-full w-full object-cover" />
                  )}
                </span>
                <span className="block px-2.5 py-2">
                  <span className="block truncate text-[13px] font-semibold">{m.nombre}</span>
                  <span className="block text-xs text-text-3">
                    {m.mime.split("/")[1]?.toUpperCase()} · {formatBytes(m.bytes)}
                  </span>
                </span>
              </button>
              {/* Casilla: visible al pasar el cursor, y siempre en pantallas táctiles o con algo elegido. */}
              <label
                className={cn(
                  "absolute left-2 top-2 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-black/60 transition-opacity focus-within:opacity-100",
                  seleccion.has(m.id) || seleccion.size > 0
                    ? "opacity-100"
                    : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                )}
              >
                <input
                  type="checkbox"
                  checked={seleccion.has(m.id)}
                  onChange={() => alternar(m.id)}
                  aria-label={`Seleccionar ${m.nombre}`}
                  className="h-4 w-4 cursor-pointer accent-brand"
                />
              </label>
              <button
                type="button"
                onClick={() => void copiar(m)}
                aria-label={copiado === m.id ? "URL copiada" : `Copiar URL de ${m.nombre}`}
                title={copiado === m.id ? "¡URL copiada!" : "Copiar URL"}
                className={cn(
                  "absolute right-12 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white transition-opacity hover:bg-black/80 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white",
                  copiado === m.id ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                )}
              >
                {copiado === m.id ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
              </button>
              <button
                type="button"
                onClick={() => setBorrando([m])}
                aria-label={`Borrar ${m.nombre}`}
                title="Borrar"
                className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white opacity-100 transition-opacity hover:bg-danger focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:opacity-0 sm:group-hover:opacity-100"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Zona de soltar */}
      {arrastrando && (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-brand bg-brand-tint"
          aria-hidden
        >
          <p className="flex items-center gap-2 text-sm font-semibold text-brand">
            <Upload className="h-5 w-5" /> Suelta los archivos para subirlos
          </p>
        </div>
      )}

      {medioViendo && (
        <MedioDialog
          key={medioViendo.id}
          medio={medioViendo}
          hayAnterior={indiceViendo > 0}
          haySiguiente={indiceViendo < visibles.length - 1}
          onClose={() => setViendo(null)}
          onPrev={() => {
            const anterior = visibles[indiceViendo - 1];
            if (anterior) setViendo(anterior.id);
          }}
          onNext={() => {
            const siguiente = visibles[indiceViendo + 1];
            if (siguiente) setViendo(siguiente.id);
          }}
          copiado={copiado === medioViendo.id}
          onCopy={() => void copiar(medioViendo)}
          onRenamed={(nuevo) =>
            setMedios((prev) => (prev ?? []).map((x) => (x.id === nuevo.id ? nuevo : x)))
          }
          onDelete={() => setBorrando([medioViendo])}
        />
      )}

      {borrando && (
        <ConfirmDialog
          title={borrando.length === 1 ? "Borrar archivo" : `Borrar ${borrando.length} archivos`}
          message={
            borrando.length === 1 ? (
              <>
                Se borrará «{borrando[0]!.nombre}» de la biblioteca. Si lo usas en un servicio u
                oferta, se quedará sin imagen. No se puede deshacer.
              </>
            ) : (
              <>
                Se borrarán {borrando.length} archivos de la biblioteca. Si los usas en servicios u
                ofertas, se quedarán sin imagen. No se puede deshacer.
              </>
            )
          }
          confirmLabel={borrando.length === 1 ? "Borrar" : `Borrar ${borrando.length}`}
          onConfirm={() => borrar(borrando)}
          onClose={() => setBorrando(null)}
        />
      )}
    </div>
  );
}
