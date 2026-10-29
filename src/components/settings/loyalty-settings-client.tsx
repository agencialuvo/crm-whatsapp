"use client";

import { useEffect, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchSelect } from "@/components/ui/search-select";
import { apiFetch, describeError } from "@/components/negocio/api";
import { MediaImageField, type ImagenElegida } from "@/components/medios/media-picker";
import {
  loyaltySettingsInputSchema,
  MAX_MILESTONES,
  MAX_STAMPS_REQUIRED,
  REWARD_TYPE_LABELS,
  REWARD_TYPES,
  sortMilestones,
  type RewardType,
} from "@/lib/loyalty";
import type { ServiceDto } from "@/lib/salon/types";
import { cn } from "@/lib/utils";

type MilestoneDto = {
  stamps: number;
  title: string;
  rewardType: RewardType;
  discountPercentage?: number;
  serviceIdRestriction?: string;
};

type SettingsDto = {
  milestones: MilestoneDto[];
  cardTitle: string;
  brandColor: string;
  stampIconMediaId: string | null;
};

/** Un premio en edición: los números se teclean como texto. */
type Row = {
  key: number;
  stamps: string;
  title: string;
  rewardType: RewardType;
  discount: string;
  serviceId: string;
};

const DEFAULT_COLOR = "#111827";
const COLOR_PRESETS = ["#111827", "#0d5bff", "#157a41", "#b45309", "#be123c", "#7c3aed"];
const ANY_SERVICE = "__any";

const TYPE_OPTIONS = REWARD_TYPES.map((t) => ({ value: t, label: REWARD_TYPE_LABELS[t] }));

let nextKey = 1;
const toRow = (m: MilestoneDto): Row => ({
  key: nextKey++,
  stamps: String(m.stamps),
  title: m.title,
  rewardType: m.rewardType,
  discount: m.discountPercentage != null ? String(m.discountPercentage) : "",
  serviceId: m.serviceIdRestriction ?? "",
});

/** Ajustes → Fidelización: los premios por hito del programa de sellos y el aspecto de la tarjeta. */
export function LoyaltySettingsClient() {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [services, setServices] = useState<ServiceDto[]>([]);
  const [title, setTitle] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [icon, setIcon] = useState<ImagenElegida | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch<SettingsDto>("/api/loyalty/settings")
      .then((s) => {
        if (!alive) return;
        setRows(sortMilestones(s.milestones).map(toRow));
        setTitle(s.cardTitle);
        setColor(s.brandColor);
        setIcon(s.stampIconMediaId ? { id: s.stampIconMediaId, url: `/api/medios/${s.stampIconMediaId}/archivo` } : null);
        setLoaded(true);
      })
      .catch((err) => alive && setLoadError(describeError(err)));
    // Los servicios solo alimentan el filtro opcional «servicio gratis de…»: si fallan, se omite.
    apiFetch<{ services: ServiceDto[] }>("/api/negocio/servicios")
      .then((r) => alive && setServices(r.services.filter((x) => x.active)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const patchRow = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  function addRow() {
    const last = Math.max(0, ...rows.map((r) => Number(r.stamps) || 0));
    setRows((rs) => [
      ...rs,
      { key: nextKey++, stamps: String(Math.min(MAX_STAMPS_REQUIRED, last + 4)), title: "", rewardType: "service_free", discount: "", serviceId: "" },
    ]);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    const parsed = loyaltySettingsInputSchema.safeParse({
      milestones: rows.map((r) => ({
        stamps: r.stamps.trim() === "" ? undefined : Number(r.stamps),
        title: r.title,
        rewardType: r.rewardType,
        discountPercentage: r.rewardType === "percentage_discount" && r.discount.trim() !== "" ? Number(r.discount) : null,
        serviceIdRestriction: r.rewardType === "service_free" && r.serviceId ? r.serviceId : null,
      })),
      cardTitle: title,
      brandColor: color,
      stampIconMediaId: icon?.id ?? null,
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
      const saved = await apiFetch<SettingsDto>("/api/loyalty/settings", { method: "PUT", json: parsed.data });
      setRows(sortMilestones(saved.milestones).map(toRow));
      setNotice({ kind: "ok", text: "Configuración guardada. Las tarjetas ya usan las nuevas reglas." });
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

  const serviceOptions = [
    { value: ANY_SERVICE, label: "Cualquier servicio" },
    ...services.map((s) => ({ value: s.id, label: s.name })),
  ];
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_COLOR;
  const numbers = rows.map((r) => Number(r.stamps)).filter((n) => Number.isInteger(n) && n > 0);
  const finalStamps = Math.max(0, ...numbers);
  const previewDots = Math.min(finalStamps, 24);
  const prizeAt = new Set(numbers.map((n) => (finalStamps > 24 ? Math.ceil((n / finalStamps) * 24) : n)));

  return (
    <form onSubmit={save} noValidate className="max-w-2xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Premios por hito</CardTitle>
          <CardDescription>
            Cada venta con cliente identificado suma un sello. Al llegar a un hito, el cliente puede canjear ese
            premio (se descuentan los sellos del hito). El de más sellos es el premio final. Las ventas con
            descuento de cumpleaños no suman sello.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {errors.milestones && <p className="text-xs text-danger-text">{errors.milestones}</p>}
          <ul className="space-y-3">
            {rows.map((r, i) => {
              const err = (f: string) => errors[`milestones.${i}.${f}`];
              return (
                <li key={r.key} className="space-y-3 rounded-md border bg-subtle/40 p-3">
                  <div className="grid gap-3 sm:grid-cols-[7rem_1fr_auto] sm:items-end">
                    <div className="space-y-1.5">
                      <Label htmlFor={`loy-stamps-${r.key}`} required>En el sello</Label>
                      <Input
                        id={`loy-stamps-${r.key}`}
                        inputMode="numeric"
                        value={r.stamps}
                        // Solo dígitos: no se puede teclear ni pegar otra cosa.
                        onChange={(e) => patchRow(r.key, { stamps: e.target.value.replace(/\D/g, "").slice(0, 2) })}
                        className="tabular-nums"
                        aria-invalid={!!err("stamps")}
                        disabled={saving}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`loy-title-${r.key}`} required>Premio</Label>
                      <Input
                        id={`loy-title-${r.key}`}
                        value={r.title}
                        maxLength={120}
                        placeholder="Ej. Corte gratis, 20% de descuento"
                        onChange={(e) => patchRow(r.key, { title: e.target.value })}
                        aria-invalid={!!err("title")}
                        disabled={saving}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Quitar premio ${i + 1}`}
                      disabled={saving || rows.length <= 1}
                      onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                      className="text-danger-text hover:text-danger-text"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                  {(err("stamps") || err("title")) && (
                    <p className="text-xs text-danger-text">{err("stamps") ?? err("title")}</p>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`loy-type-${r.key}`}>Tipo de recompensa</Label>
                      <SearchSelect
                        id={`loy-type-${r.key}`}
                        value={r.rewardType}
                        onChange={(v) => patchRow(r.key, { rewardType: v as RewardType })}
                        options={TYPE_OPTIONS}
                        searchPlaceholder="Buscar tipo…"
                        disabled={saving}
                        triggerClassName="bg-card px-2"
                      />
                    </div>
                    {r.rewardType === "percentage_discount" && (
                      <div className="space-y-1.5">
                        <Label htmlFor={`loy-discount-${r.key}`} required>Porcentaje de descuento</Label>
                        <div className="flex items-center gap-2">
                          <Input
                            id={`loy-discount-${r.key}`}
                            inputMode="numeric"
                            value={r.discount}
                            onChange={(e) => patchRow(r.key, { discount: e.target.value.replace(/\D/g, "").slice(0, 3) })}
                            className="max-w-[8rem] tabular-nums"
                            aria-invalid={!!err("discountPercentage")}
                            disabled={saving}
                          />
                          <span className="text-sm text-text-2">%</span>
                        </div>
                        {err("discountPercentage") && (
                          <p className="text-xs text-danger-text">{err("discountPercentage")}</p>
                        )}
                      </div>
                    )}
                    {r.rewardType === "service_free" && services.length > 0 && (
                      <div className="space-y-1.5">
                        <Label htmlFor={`loy-service-${r.key}`}>Aplica a</Label>
                        <SearchSelect
                          id={`loy-service-${r.key}`}
                          value={r.serviceId || ANY_SERVICE}
                          onChange={(v) => patchRow(r.key, { serviceId: v === ANY_SERVICE ? "" : v })}
                          options={serviceOptions}
                          searchPlaceholder="Buscar servicio…"
                          disabled={saving}
                          triggerClassName="bg-card px-2"
                        />
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addRow}
            disabled={saving || rows.length >= MAX_MILESTONES}
          >
            <Plus className="mr-1 h-4 w-4" aria-hidden />
            Agregar premio
          </Button>
          <p className="text-xs text-text-3">
            Hasta {MAX_MILESTONES} premios, entre el sello 1 y el {MAX_STAMPS_REQUIRED}. Ej: 4 → 20% de descuento, 8 → corte gratis.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Aspecto de la tarjeta</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="loy-title" required>Nombre de la tarjeta</Label>
            <Input
              id="loy-title"
              value={title}
              maxLength={40}
              onChange={(e) => setTitle(e.target.value)}
              aria-invalid={!!errors.cardTitle}
              disabled={saving}
              className="max-w-sm"
            />
            {errors.cardTitle && <p className="text-xs text-danger-text">{errors.cardTitle}</p>}
          </div>

          <div className="max-w-xs">
            <MediaImageField
              id="loy-icon"
              label="Icono de los sellos (opcional)"
              permitirSvg
              value={icon}
              onChange={setIcon}
              disabled={saving}
              error={errors.stampIconMediaId}
            />
            <p className="mt-1 text-xs text-text-3">Una imagen cuadrada o un SVG (tijera, navaja…). Sin icono se usa un palomito.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="loy-color">Color de la tarjeta</Label>
            <div className="flex flex-wrap items-center gap-2">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                  aria-pressed={color.toLowerCase() === c}
                  disabled={saving}
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-full border transition-shadow",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    color.toLowerCase() === c ? "ring-2 ring-text-2 ring-offset-2 ring-offset-background" : "border-border-strong"
                  )}
                  style={{ backgroundColor: c }}
                >
                  {color.toLowerCase() === c && <Check className="h-3.5 w-3.5 text-white" aria-hidden />}
                </button>
              ))}
              <input
                type="color"
                aria-label="Elegir otro color"
                value={hex}
                onChange={(e) => setColor(e.target.value)}
                disabled={saving}
                className="h-7 w-9 cursor-pointer rounded-md border border-border-strong bg-transparent p-0.5"
              />
              <Input
                id="loy-color"
                value={color}
                maxLength={7}
                onChange={(e) => setColor(e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`)}
                className="w-28 font-mono text-xs uppercase"
                aria-invalid={!!errors.brandColor}
                disabled={saving}
              />
            </div>
            {errors.brandColor && <p className="text-xs text-danger-text">{errors.brandColor}</p>}
          </div>

          <div aria-label="Vista previa de la tarjeta" className="rounded-md border bg-subtle/50 p-3">
            <p className="kicker">{title.trim() || "Tarjeta VIP"}</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums">
              0 / {finalStamps || "–"} <span className="font-normal text-text-3">sellos</span>
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {Array.from({ length: previewDots }, (_, i) => {
                const on = i < Math.ceil(previewDots / 3);
                return (
                  <span
                    key={i}
                    className={cn(
                      "flex h-5 w-5 items-center justify-center rounded-full border text-white",
                      !on && prizeAt.has(i + 1) && "border-2 border-border-strong"
                    )}
                    style={on ? { backgroundColor: hex, borderColor: hex } : undefined}
                  >
                    {on &&
                      (icon ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={icon.url} alt="" className="h-3.5 w-3.5 rounded-full object-cover" />
                      ) : (
                        <Check className="h-3 w-3" aria-hidden />
                      ))}
                  </span>
                );
              })}
            </div>
            <ul className="mt-2 space-y-0.5 text-xs text-text-3">
              {sortMilestones(rows.map((r) => ({ stamps: Number(r.stamps) || 0, title: r.title.trim() || "—" }))).map(
                (m, i) => (
                  <li key={i}>
                    Sello {m.stamps || "–"}: {m.title}
                  </li>
                )
              )}
            </ul>
          </div>

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
        </CardContent>
      </Card>
    </form>
  );
}
