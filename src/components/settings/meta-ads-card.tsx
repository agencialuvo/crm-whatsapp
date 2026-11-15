"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * 038/039 — Ajustes → Anuncios, primer bloque de la tarjeta «Meta Ads»: conectar la cuenta publicitaria para
 * traer a Resultados la jerarquía Campaña › Conjunto › Anuncio y el gasto de TODA la cuenta.
 *
 * Opcional: sin conectar, el CRM funciona exactamente igual (solo el anuncio de origen).
 */

type MetaAds = {
  adAccountId: string;
  tokenLast4: string;
  status: "connected" | "error";
  lastError: string | null;
  accountName: string | null;
  currency: string | null;
  pausedUntil: string | null;
  lastSpendSyncAt: string | null;
  catalogSyncedAt: string | null;
  spendCoveredSince: string | null;
  accountTimezone: string | null;
  pending: number;
  failed: number;
};

function cuando(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("es-MX") : "todavía no";
}

export function MetaAdsSection({ onConnected }: { onConnected?: (connected: boolean) => void }) {
  const [meta, setMeta] = useState<MetaAds | null | undefined>(undefined);
  const [adAccountId, setAdAccountId] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<null | "save" | "sync" | "disconnect">(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/meta-ads").catch(() => null);
    if (!res?.ok) {
      setMeta(null);
      onConnected?.(false);
      return;
    }
    const data = (await res.json()) as { metaAds: MetaAds | null };
    setMeta(data.metaAds);
    onConnected?.(!!data.metaAds && data.metaAds.status === "connected");
    if (data.metaAds) setAdAccountId((prev) => prev || data.metaAds!.adAccountId);
  }, [onConnected]);

  useEffect(() => {
    void load();
  }, [load]);

  async function errorDe(res: Response | null, porDefecto: string): Promise<string> {
    const body = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
    return body?.error?.message ?? porDefecto;
  }

  async function save() {
    setBusy("save");
    setError(null);
    setInfo(null);
    const res = await fetch("/api/settings/meta-ads", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adAccountId: adAccountId.trim(), ...(token.trim() ? { token: token.trim() } : {}) }),
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) return setError(await errorDe(res, "No se pudo guardar"));
    const data = (await res.json()) as { accountName: string | null };
    setToken("");
    setInfo(
      `Conectado${data.accountName ? ` a «${data.accountName}»` : ""}. Se está trayendo toda la cuenta: campañas, conjuntos, anuncios y su gasto.`
    );
    await load();
  }

  async function sync() {
    setBusy("sync");
    setError(null);
    setInfo(null);
    const res = await fetch("/api/settings/meta-ads/sync", { method: "POST" }).catch(() => null);
    setBusy(null);
    if (!res?.ok) return setError(await errorDe(res, "No se pudo sincronizar"));
    setInfo("Sincronización lista.");
    await load();
  }

  async function disconnect() {
    setBusy("disconnect");
    setError(null);
    setInfo(null);
    await fetch("/api/settings/meta-ads", { method: "DELETE" }).catch(() => null);
    setBusy(null);
    setMeta(null);
    setAdAccountId("");
    setToken("");
    onConnected?.(false);
  }

  if (meta === undefined) return null;

  return (
    <section className="space-y-4" aria-labelledby="meta-ads-datos">
      <div>
        <h3 id="meta-ads-datos" className="text-sm font-semibold">
          Campañas y gasto
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Conecta tu cuenta publicitaria y Resultados mostrará, por campaña, conjunto y anuncio, cuánto gastaste
          y cuánto te cuesta cada conversación, prospecto y cita. Trae toda la cuenta, también lo que está
          pausado o no ha traído mensajes. Es opcional: sin conectar, el CRM sigue mostrando de qué anuncio
          llegó cada persona.
        </p>
      </div>

      {meta ? (
        <div className="space-y-1.5 rounded-md border bg-subtle px-3 py-2.5 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <Badge variant={meta.status === "connected" ? "success" : "destructive"}>
              {meta.status === "connected" ? "Conectado" : "Necesita atención"}
            </Badge>
            <span className="font-medium">{meta.accountName ?? meta.adAccountId}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {meta.adAccountId} · token ····{meta.tokenLast4}
              {meta.currency ? ` · ${meta.currency}` : ""}
            </span>
          </p>
          {meta.lastError && (
            <p className={meta.status === "error" ? "text-danger-text" : "text-warning-text"} role="alert">
              {meta.lastError}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Cuenta leída: {cuando(meta.catalogSyncedAt)} · gasto sincronizado: {cuando(meta.lastSpendSyncAt)}
            {meta.spendCoveredSince ? ` · con gasto desde el ${meta.spendCoveredSince}` : ""}
            {meta.pending > 0 ? ` · ${meta.pending} anuncio(s) por consultar` : ""}
            {meta.failed > 0 ? ` · ${meta.failed} sin poder leerse (se reintentan solos)` : ""}
            {meta.pausedUntil && new Date(meta.pausedUntil) > new Date()
              ? ` · en pausa por el límite de uso de Meta hasta ${cuando(meta.pausedUntil)}`
              : ""}
          </p>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="meta-ads-account" required>
          ID de la cuenta publicitaria
        </Label>
        <Input
          id="meta-ads-account"
          value={adAccountId}
          onChange={(e) => setAdAccountId(e.target.value)}
          placeholder="act_1234567890"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          Administrador de anuncios de Meta → Configuración de la cuenta. Sirve con o sin el prefijo «act_».
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="meta-ads-token" required={!meta}>
          Token de la API de Marketing
        </Label>
        <Input
          id="meta-ads-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={meta ? "Déjalo vacío para conservar el actual" : "EAAB…"}
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          Un token con el permiso <span className="font-mono">ads_read</span> (usuario del sistema del Business
          Manager). No sirve el de WhatsApp. Se guarda cifrado y no vuelve a mostrarse.
        </p>
      </div>

      {error ? (
        <p className="text-sm text-danger-text" role="alert">
          {error}
        </p>
      ) : null}
      {info ? <p className="text-sm text-success-text">{info}</p> : null}

      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={busy !== null || !adAccountId.trim() || (!meta && !token.trim())}>
          {busy === "save" ? "Probando…" : meta ? "Guardar y probar" : "Conectar"}
        </Button>
        {meta ? (
          <>
            <Button variant="outline" onClick={sync} disabled={busy !== null || meta.status === "error"}>
              {busy === "sync" ? "Sincronizando…" : "Sincronizar ahora"}
            </Button>
            <Button variant="outline" onClick={disconnect} disabled={busy !== null}>
              Desconectar
            </Button>
          </>
        ) : null}
      </div>
      {meta ? (
        <p className="text-xs text-muted-foreground">
          Al desconectar se conserva lo ya traído (nombres y gasto); solo se detiene la sincronización.
        </p>
      ) : null}
    </section>
  );
}
