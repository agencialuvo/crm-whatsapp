"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchSelect } from "@/components/ui/search-select";
import { CapiEventsLog } from "@/components/settings/capi-events-log";
import { MetaAdsSection } from "@/components/settings/meta-ads-card";

/**
 * 016/039 — Ajustes → Anuncios: UNA tarjeta «Meta Ads» con las dos conexiones con Meta, cada una en su
 * bloque y con su propio Guardar:
 *  1. Campañas y gasto (Marketing API): trae la cuenta a Resultados.
 *  2. Conversiones (CAPI): le avisa a Meta qué leads se calificaron y cuáles compraron.
 * El registro de lo reportado queda en un acordeón cerrado: es depuración, no ajuste.
 */

type Capi = {
  datasetId: string;
  status: "connected" | "error";
  tokenLast4: string;
  qualifiedStageId: string | null;
};

type Stage = { id: string; name: string; kind: "open" | "won" | "lost" };
type Pixel = { id: string; name: string };

const MANUAL = "__manual__";

export function AdsClient() {
  const [metaConnected, setMetaConnected] = useState(false);
  const onConnected = useCallback((c: boolean) => setMetaConnected(c), []);

  const [capi, setCapi] = useState<Capi | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [token, setToken] = useState("");
  const [qualifiedStageId, setQualifiedStageId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // La lista de datasets sale de la cuenta publicitaria; sin ella (o si Meta no la da) queda el ID a mano.
  const [pixels, setPixels] = useState<Pixel[] | null>(null);
  const [pixelsError, setPixelsError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    void (async () => {
      const [cfg, stg] = await Promise.all([
        fetch("/api/settings/capi").catch(() => null),
        fetch("/api/pipeline/stages").catch(() => null),
      ]);
      if (cfg?.ok) {
        const data = (await cfg.json()) as { capi: Capi | null };
        setCapi(data.capi);
        setDatasetId(data.capi?.datasetId ?? "");
        setQualifiedStageId(data.capi?.qualifiedStageId ?? "");
      }
      if (stg?.ok) {
        const data = (await stg.json()) as { stages: Stage[] };
        setStages(data.stages);
      }
    })();
  }, []);

  useEffect(() => {
    if (!metaConnected) {
      setPixels(null);
      setPixelsError(null);
      return;
    }
    void (async () => {
      const res = await fetch("/api/settings/meta-ads/pixels").catch(() => null);
      if (!res?.ok) {
        const body = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
        setPixelsError(body?.error?.message ?? "No se pudo leer la lista de datasets.");
        setPixels([]);
        return;
      }
      setPixelsError(null);
      setPixels(((await res.json()) as { pixels: Pixel[] }).pixels);
    })();
  }, [metaConnected]);

  // Un dataset guardado que no está en la lista (p. ej. el de WhatsApp) se muestra en el campo manual.
  useEffect(() => {
    if (pixels && datasetId && !pixels.some((p) => p.id === datasetId)) setManual(true);
  }, [pixels, datasetId]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/settings/capi", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        datasetId: datasetId.trim(),
        // Vacío = reusar el token de WhatsApp. Se omite en vez de mandar "".
        ...(token.trim() ? { token: token.trim() } : {}),
        qualifiedStageId: qualifiedStageId || null,
      }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? "No se pudo guardar");
      return;
    }
    setToken("");
    setSaved(true);
    const cfg = await fetch("/api/settings/capi").catch(() => null);
    if (cfg?.ok) {
      const data = (await cfg.json()) as { capi: Capi | null };
      setCapi(data.capi);
    }
  }

  async function disconnect() {
    setSaving(true);
    await fetch("/api/settings/capi", { method: "DELETE" }).catch(() => null);
    setSaving(false);
    setCapi(null);
    setDatasetId("");
    setToken("");
    setQualifiedStageId("");
    setSaved(false);
    setManual(false);
  }

  const hayLista = !!pixels && pixels.length > 0;
  const opciones = [
    ...(pixels ?? []).map((p) => ({ value: p.id, label: `${p.name} · ${p.id}` })),
    { value: MANUAL, label: "Escribir el ID a mano…" },
  ];

  return (
    <Card data-meta-ads>
      <CardHeader>
        <CardTitle>Meta Ads</CardTitle>
        <CardDescription>
          Dos conexiones con Meta, independientes: una trae a Resultados tus campañas y tu gasto; la otra le
          avisa a Meta qué conversaciones sirvieron, para que optimice hacia quien compra y no hacia quien
          solo escribe.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <MetaAdsSection onConnected={onConnected} />

        <hr className="border-border" />

        <section className="space-y-4" aria-labelledby="capi-titulo" data-capi>
          <div>
            <h3 id="capi-titulo" className="text-sm font-semibold">
              Conversiones
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Conecta tu dataset y el CRM le avisará a Meta cuándo un lead se califica y cuándo se cierra la
              venta.
            </p>
            {capi ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Conectado al dataset <span className="font-medium text-foreground">{capi.datasetId}</span> · token ····
                {capi.tokenLast4}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="capi-dataset" required>
              Dataset de Meta
            </Label>
            {hayLista && !manual ? (
              <SearchSelect
                id="capi-dataset"
                value={datasetId}
                onChange={(v) => {
                  if (v === MANUAL) {
                    setManual(true);
                    return;
                  }
                  setDatasetId(v);
                }}
                options={opciones}
                emptyLabel="Elige un dataset"
                searchPlaceholder="Buscar dataset…"
                triggerClassName="bg-card px-2"
              />
            ) : (
              <Input
                id="capi-dataset"
                value={datasetId}
                onChange={(e) => setDatasetId(e.target.value)}
                placeholder="1708105527110154"
                inputMode="numeric"
              />
            )}
            <p className="text-xs text-muted-foreground">
              {hayLista && !manual
                ? "Los datasets de tu cuenta publicitaria. Si el tuyo no aparece, elige «Escribir el ID a mano»."
                : "Administrador de eventos de Meta → tu conjunto de datos. Suele ser el de tu propia cuenta de WhatsApp."}
              {hayLista && manual ? (
                <>
                  {" "}
                  <button type="button" className="text-brand underline" onClick={() => setManual(false)}>
                    Elegir de la lista
                  </button>
                </>
              ) : null}
            </p>
            {pixelsError ? <p className="text-xs text-warning-text">{pixelsError} Puedes escribir el ID a mano.</p> : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="capi-token">Token (opcional)</Label>
            <Input
              id="capi-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Déjalo vacío para reusar el de WhatsApp"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              El token de tu conexión de WhatsApp ya suele poder publicar en el dataset. Solo pega uno si Meta te
              dio otro distinto.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="capi-stage">¿Qué etapa es un lead calificado?</Label>
            <SearchSelect
              id="capi-stage"
              value={qualifiedStageId}
              onChange={setQualifiedStageId}
              options={stages.filter((s) => s.kind === "open").map((s) => ({ value: s.id, label: s.name }))}
              emptyLabel="No reportar leads calificados"
              searchPlaceholder="Buscar etapa…"
              triggerClassName="bg-card px-2"
            />
            <p className="text-xs text-muted-foreground">La venta se reporta sola cuando el trato entra a tu etapa ganada.</p>
          </div>

          {error ? (
            <p className="text-sm text-danger-text" role="alert">
              {error}
            </p>
          ) : null}
          {saved ? <p className="text-sm text-success-text">Guardado.</p> : null}

          <div className="flex gap-2">
            <Button onClick={save} disabled={saving || !datasetId.trim()}>
              {saving ? "Guardando…" : "Guardar"}
            </Button>
            {capi ? (
              <Button variant="outline" onClick={disconnect} disabled={saving}>
                Desconectar
              </Button>
            ) : null}
          </div>

          <CapiEventsLog />
        </section>
      </CardContent>
    </Card>
  );
}
