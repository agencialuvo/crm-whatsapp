"use client";

import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Info, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeError } from "@/components/negocio/api";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import {
  BULK_COLUMNS,
  BULK_MAX_BYTES,
  BULK_MAX_ROWS,
  BULK_TITLES,
  type BulkModule,
  type BulkResult,
} from "@/lib/salon/bulk";
import { cn } from "@/lib/utils";

const NOTES: Record<BulkModule, string> = {
  servicios:
    "Una fila por servicio u oferta (columna «tipo»). Si ya existe uno con el mismo nombre, se omite. La imagen es la URL que copias en Medios.",
  equipo:
    "Una fila por profesional. Si ya hay uno con el mismo nombre, se omite. La foto es la URL que copias en Medios.",
  clientes:
    "Una fila por cliente. Si el celular ya es un contacto, pasa a ser cliente sin duplicarse. No se registra ninguna venta.",
};

/**
 * Módulo SALON — «Carga masiva» (Servicios y ofertas, Equipo, Clientes): descargar
 * la plantilla de Excel, subir el archivo completado y ver cuántas filas entraron
 * y cuáles no (con su fila y columna). Un solo diálogo para los tres módulos.
 */
export function BulkImportDialog({
  module,
  onClose,
  onImported,
}: {
  module: BulkModule;
  onClose: () => void;
  /** Avisa a la pantalla que entraron registros, para que se refresque. */
  onImported: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function choose(f: File | undefined) {
    setResult(null);
    setError(null);
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) {
      setFile(null);
      setError("Sube un archivo Excel en formato .xlsx (usa la plantilla).");
      return;
    }
    if (f.size > BULK_MAX_BYTES) {
      setFile(null);
      setError("El archivo pesa más de 2 MB. Divídelo en partes.");
      return;
    }
    setFile(f);
  }

  async function process() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/negocio/carga-masiva?modulo=${module}`, { method: "POST", body });
      const data = (await res.json().catch(() => null)) as (BulkResult & { error?: { message?: string } }) | null;
      if (!res.ok || !data) {
        throw new Error(data?.error?.message ?? "No se pudo procesar el archivo.");
      }
      setResult(data);
      if (data.created > 0) onImported();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const columns = BULK_COLUMNS[module];
  const problems = result ? [...result.errors, ...result.skipped.map((s) => ({ ...s, skipped: true }))] : [];

  return (
    <Modal
      title={`Carga masiva: ${BULK_TITLES[module]}`}
      description="Importa muchos registros a la vez desde un archivo de Excel."
      onClose={onClose}
      busy={busy}
      size="lg"
    >
      <div className="space-y-5">
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">1. Descarga la plantilla</h3>
          <p className="flex items-start gap-1.5 text-xs text-text-2">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              {NOTES[module]} Máximo {BULK_MAX_ROWS} filas. Borra las filas de ejemplo y no cambies los encabezados.
            </span>
          </p>
          <a
            href={`/api/negocio/carga-masiva/plantilla?modulo=${module}`}
            download
            className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Download className="h-4 w-4" aria-hidden />
            Descargar plantilla (.xlsx)
          </a>
          <p className="text-xs text-text-3">
            Columnas:{" "}
            {columns.map((c, i) => (
              <span key={c.key}>
                {i > 0 && ", "}
                <span className={c.required ? "font-semibold text-text-2" : undefined}>
                  {c.key}
                  {c.required ? "*" : ""}
                </span>
              </span>
            ))}
            . (* obligatoria)
          </p>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">2. Sube el archivo completado</h3>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              choose(e.dataTransfer.files[0]);
            }}
            className={cn(
              "flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-6 text-center transition-colors",
              dragging ? "border-brand bg-brand-tint" : "border-border-strong bg-subtle/50"
            )}
          >
            {file ? (
              <p className="flex items-center gap-2 text-sm font-medium">
                <FileSpreadsheet className="h-5 w-5 text-brand-text" aria-hidden />
                <span className="truncate">{file.name}</span>
              </p>
            ) : (
              <p className="text-sm text-text-2">Arrastra aquí tu archivo .xlsx o elígelo.</p>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
              <Upload className="h-4 w-4" aria-hidden />
              {file ? "Elegir otro archivo" : "Elegir archivo"}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              tabIndex={-1}
              aria-label="Elegir el archivo de Excel"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                choose(f);
              }}
            />
          </div>
        </section>

        {error && (
          <p role="alert" className="flex items-start gap-1.5 rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        {result && (
          <section aria-live="polite" className="space-y-3">
            <p
              className={cn(
                "flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium",
                result.created > 0 ? "border-success-soft bg-success-tint text-success-text" : "bg-subtle text-text-2"
              )}
            >
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
              {result.created} de {result.total} fila{result.total === 1 ? "" : "s"} importada
              {result.created === 1 ? "" : "s"}
              {result.skipped.length > 0 && ` · ${result.skipped.length} omitida${result.skipped.length === 1 ? "" : "s"}`}
              {result.errors.length > 0 && ` · ${result.errors.length} con error`}
            </p>
            {problems.length > 0 && (
              <div className="max-h-56 overflow-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-subtle text-left text-xs font-semibold text-text-2">
                      <th scope="col" className="px-3 py-2">Fila</th>
                      <th scope="col" className="px-2 py-2">Columna</th>
                      <th scope="col" className="px-2 py-2">Detalle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {problems.map((p, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">{p.row}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-text-2">{p.column ?? "—"}</td>
                        <td className={cn("px-2 py-1.5", "skipped" in p ? "text-text-2" : "text-danger-text")}>
                          {"skipped" in p && <span className="mr-1.5 text-[11px] font-semibold uppercase">Omitida</span>}
                          {p.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {result.errors.length > 0 && (
              <p className="text-xs text-text-3">
                Corrige esas filas en tu archivo y vuelve a subirlo: las que ya entraron se omiten solas.
              </p>
            )}
          </section>
        )}

        <ModalFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {result ? "Cerrar" : "Cancelar"}
          </Button>
          <Button type="button" onClick={() => void process()} disabled={!file || busy}>
            <Upload className="h-4 w-4" aria-hidden />
            {busy ? "Procesando…" : "Procesar importación"}
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
