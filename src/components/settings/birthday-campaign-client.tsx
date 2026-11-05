"use client";

import { useEffect, useState } from "react";
import { Cake } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clampPercent } from "@/lib/percent";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { apiFetch, describeError } from "@/components/negocio/api";
import { ServiceMultiSelect } from "@/components/settings/service-multi-select";
import { BIRTHDAY_DEFAULT_PERCENTAGE, birthdayCampaignInputSchema, type BirthdayCampaignDto } from "@/lib/loyalty";
import type { ComboDto, ServiceDto } from "@/lib/salon/types";
import { cn } from "@/lib/utils";

/**
 * Ajustes → Marketing → Campaña de cumpleaños: el interruptor general, el porcentaje y los servicios
 * sobre los que se puede rebajar. Apagada, Caja no muestra el descuento; encendida, Caja lo ofrece durante
 * el mes de cumpleaños del cliente y solo si todo lo vendido es un servicio de esta lista.
 */
export function BirthdayCampaignClient({ currency }: { currency: string }) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [percentage, setPercentage] = useState(String(BIRTHDAY_DEFAULT_PERCENTAGE));
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [services, setServices] = useState<ServiceDto[]>([]);
  const [offers, setOffers] = useState<ComboDto[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch<BirthdayCampaignDto>("/api/loyalty/birthday")
      .then((c) => {
        if (!alive) return;
        setEnabled(c.enabled);
        setPercentage(String(c.percentage));
        setServiceIds(c.serviceIds);
        setLoaded(true);
      })
      .catch((err) => alive && setLoadError(describeError(err)));
    apiFetch<{ services: ServiceDto[] }>("/api/negocio/servicios")
      .then((r) => alive && setServices(r.services.filter((x) => x.active)))
      .catch(() => undefined);
    apiFetch<{ combos: ComboDto[] }>("/api/negocio/ofertas")
      .then((r) => alive && setOffers(r.combos.filter((x) => x.active)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    const parsed = birthdayCampaignInputSchema.safeParse({
      enabled,
      percentage: percentage.trim() === "" ? undefined : Number(percentage),
      serviceIds,
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const i of parsed.error.issues) next[i.path.join(".")] ??= i.message;
      setErrors(next);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const saved = await apiFetch<BirthdayCampaignDto>("/api/loyalty/birthday", { method: "PUT", json: parsed.data });
      setEnabled(saved.enabled);
      setPercentage(String(saved.percentage));
      setServiceIds(saved.serviceIds);
      setNotice({ kind: "ok", text: "Campaña guardada. Caja ya usa las nuevas reglas." });
    } catch (err) {
      setNotice({ kind: "error", text: describeError(err) });
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <p role="alert" className="max-w-2xl rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text">
        {loadError}
      </p>
    );
  }
  if (!loaded) return <p className="text-sm text-text-3">Cargando…</p>;

  return (
    <form onSubmit={save} noValidate className="max-w-2xl space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <Cake className="mt-1 h-5 w-5 shrink-0 text-text-3" aria-hidden />
            <div className="min-w-0 flex-1">
              <CardTitle>Campaña de cumpleaños</CardTitle>
              <CardDescription>
                Durante TODO el mes de cumpleaños del cliente, Caja ofrece el descuento al cobrar. La venta con
                este descuento no suma sello.
              </CardDescription>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={saving}
              label={enabled ? "Apagar la campaña de cumpleaños" : "Encender la campaña de cumpleaños"}
            />
          </div>
        </CardHeader>
        <CardContent>
          <p className={cn("text-sm", enabled ? "text-success-text" : "text-text-3")} role="status">
            {enabled
              ? "Campaña encendida."
              : "Campaña apagada: Caja no muestra el descuento de cumpleaños y no hay nada más que configurar."}
          </p>
        </CardContent>
      </Card>

      {enabled && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Porcentaje de descuento</CardTitle>
              <CardDescription>La rebaja que se aplica al cobrar a quien cumple años este mes.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1.5">
              <Label htmlFor="bd-percentage" required>Descuento</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="bd-percentage"
                  inputMode="numeric"
                  value={percentage}
                  onChange={(e) => setPercentage(clampPercent(e.target.value))}
                  className="max-w-[8rem] tabular-nums"
                  aria-invalid={!!errors.percentage}
                  disabled={saving}
                />
                <span className="text-sm text-text-2">%</span>
              </div>
              {errors.percentage && <p className="text-xs text-danger-text">{errors.percentage}</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Servicios y ofertas con descuento</CardTitle>
              <CardDescription>
                Marca los servicios y ofertas sobre los que aplica. Lo que no marques queda excluido (por ejemplo, los
                de alto valor). Si una venta incluye algo excluido, o un «Otro», Caja no ofrece el descuento.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ServiceMultiSelect
                idPrefix="bd-service"
                services={services}
                offers={offers}
                value={serviceIds}
                onChange={setServiceIds}
                currency={currency}
                disabled={saving}
                emptyHint="Sin marcar ninguno, el descuento aplica a todos los servicios y ofertas."
              />
            </CardContent>
          </Card>
        </>
      )}

      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            notice.kind === "ok"
              ? "border-success-soft bg-success-tint text-success-text"
              : "border-danger-soft bg-danger-tint text-danger-text"
          )}
        >
          {notice.text}
        </p>
      )}
      <Button type="submit" disabled={saving}>
        {saving ? "Guardando…" : "Guardar cambios"}
      </Button>
    </form>
  );
}
