"use client";

import { useEffect, useState } from "react";
import { Play, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { cn } from "@/lib/utils";

type ContactHit = { id: string; name: string; phone: string | null };

/** El `batchId` del diálogo: se genera UNA vez al abrirlo, así el doble clic (o un reintento de red) no repite el disparo. */
function newBatchId(): string {
  const raw = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}${Math.random()}`;
  return `b_${raw.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 64);
}

/**
 * Automatizaciones — «Ejecutar para un contacto»: arranca un flujo con disparador Manual para UNA persona.
 *
 * Busca el contacto, lo elige y lo ejecuta. El resultado real (qué se envió, si se omitió por la baja del contacto, el
 * tope de mensajes o la ventana de 24 h) queda en el Historial del flujo: aquí solo se arranca.
 */
export function ManualRunDialog({ flowId, flowName, onClose, onStarted }: { flowId: string; flowName: string; onClose: () => void; onStarted?: () => void }) {
  const [batchId] = useState(newBatchId);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<ContactHit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ started: boolean; contact: string } | null>(null);

  // Búsqueda con una pequeña espera: no se pide al servidor con cada tecla.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    let alive = true;
    setSearching(true);
    const t = setTimeout(() => {
      apiFetch<{ contacts: ContactHit[] }>(`/api/contacts?q=${encodeURIComponent(q)}`)
        .then((r) => alive && setHits(r.contacts.slice(0, 8)))
        .catch(() => alive && setHits([]))
        .finally(() => alive && setSearching(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  async function run() {
    if (!picked) return;
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch<{ started: boolean }>(`/api/automations/${flowId}/trigger`, {
        method: "POST",
        json: { contactId: picked.id, batchId },
      });
      setDone({ started: res.started, contact: picked.name });
      onStarted?.();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Ejecutar para un contacto" description={flowName} onClose={onClose} busy={busy} size="md">
      {done ? (
        <div className="space-y-4">
          <p role="status" className="rounded-md border border-success-soft bg-success-tint px-3 py-2 text-sm text-success-text">
            {done.started
              ? `Listo: el flujo empezó para ${done.contact}.`
              : `Este disparo ya se había iniciado para ${done.contact}: no se repitió.`}{" "}
            Lo que pase con cada paso lo ves en el Historial.
          </p>
          <p className="text-xs text-text-3">
            Se respetan las bajas, el tope de mensajes por contacto y la ventana de 24 h de WhatsApp: si algo se omite, el
            Historial dice por qué.
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Cerrar</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label htmlFor="manual-run-search" className="mb-1 block text-sm font-medium">
              Contacto
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />
              <Input
                id="manual-run-search"
                className="pl-8"
                value={query}
                placeholder="Busca por nombre o teléfono…"
                autoComplete="off"
                disabled={busy}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPicked(null);
                }}
              />
            </div>
            {query.trim().length >= 2 && (
              <ul aria-label="Resultados" className="mt-2 max-h-52 divide-y overflow-y-auto rounded-md border">
                {hits.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setPicked(c)}
                      aria-pressed={picked?.id === c.id}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        picked?.id === c.id && "bg-brand-tint text-brand-text"
                      )}
                    >
                      <span className="min-w-0 truncate font-medium">{c.name}</span>
                      {c.phone && <span className="shrink-0 text-xs text-text-3">{c.phone}</span>}
                    </button>
                  </li>
                ))}
                {hits.length === 0 && (
                  <li className="px-3 py-3 text-sm text-text-3">{searching ? "Buscando…" : "Ningún contacto coincide."}</li>
                )}
              </ul>
            )}
          </div>

          <p className="text-xs text-text-3">
            Un contacto a la vez. Se respetan las bajas, el tope de mensajes por contacto y la ventana de 24 h de WhatsApp.
          </p>

          <ModalFooter error={error}>
            <Button onClick={() => void run()} disabled={!picked || busy}>
              <Play className="h-4 w-4" aria-hidden />
              {busy ? "Ejecutando…" : picked ? `Ejecutar para ${picked.name}` : "Elige un contacto"}
            </Button>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
          </ModalFooter>
        </div>
      )}
    </Modal>
  );
}
