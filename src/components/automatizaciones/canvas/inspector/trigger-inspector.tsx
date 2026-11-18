"use client";

import { useMemo } from "react";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";
import { AdTriggerPicker } from "@/components/automatizaciones/ad-trigger-picker";
import { Field } from "@/components/negocio/fields";
import { BIRTHDAY_DEFAULT_HOUR, adScopeOf, parseAdReferralConfig } from "@/lib/automation";
import {
  BIRTHDAY_OFFSETS,
  CREATABLE_TRIGGERS,
  TRIGGER_HINTS,
  hourLabel,
  offsetOf,
  offsetOptionLabel,
  triggerLabel,
  type StageOption,
} from "@/lib/automation-dto";

const TRIGGER_OPTIONS: SearchSelectOption[] = CREATABLE_TRIGGERS.map((t) => ({ value: t, label: triggerLabel(t) }));
const HOUR_OPTIONS: SearchSelectOption[] = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) }));
const OFFSET_OPTIONS: SearchSelectOption[] = BIRTHDAY_OFFSETS.map((v) => ({ value: String(v), label: offsetOptionLabel(v) }));

/**
 * El panel del nodo disparador: qué lo activa y sus ajustes. Soltar otro disparador desde la paleta también lo
 * cambia; el cambio se guarda con el resto del lienzo.
 */
export function TriggerInspector({
  triggerType,
  triggerConfig,
  stages,
  onChangeType,
  onChangeConfig,
}: {
  triggerType: string;
  triggerConfig: Record<string, unknown> | null;
  stages: StageOption[];
  onChangeType: (type: string) => void;
  onChangeConfig: (config: Record<string, unknown> | null) => void;
}) {
  const cfg = triggerConfig ?? {};
  const stageOptions = useMemo<SearchSelectOption[]>(() => stages.map((s) => ({ value: s.id, label: s.name })), [stages]);

  // 047 — A qué reacciona el disparador de anuncio: cualquiera, un anuncio, un conjunto o una campaña (solo IDs).
  const adCfg = parseAdReferralConfig(triggerConfig);

  const hint = (CREATABLE_TRIGGERS as readonly string[]).includes(triggerType) ? TRIGGER_HINTS[triggerType as keyof typeof TRIGGER_HINTS] : null;
  const hour = typeof cfg.hour === "number" ? cfg.hour : BIRTHDAY_DEFAULT_HOUR;

  return (
    <div className="space-y-4">
      <Field label="Se activa cuando" htmlFor="trg-type" hint={hint ?? undefined}>
        <SearchSelect
          id="trg-type"
          value={triggerType}
          onChange={onChangeType}
          options={TRIGGER_OPTIONS}
          searchPlaceholder="Buscar disparador…"
          ariaLabel="Disparador del flujo"
        />
      </Field>

      {triggerType === "birthday" && (
        <>
          <Field label="Hora del saludo" htmlFor="trg-hour">
            <SearchSelect
              id="trg-hour"
              value={String(hour)}
              onChange={(v) => onChangeConfig({ hour: Number(v), daysOffset: offsetOf(triggerConfig) })}
              options={HOUR_OPTIONS}
              searchPlaceholder="Buscar hora…"
              ariaLabel="Hora del saludo"
            />
          </Field>
          <Field label="Momento del envío" htmlFor="trg-offset">
            <SearchSelect
              id="trg-offset"
              value={String(offsetOf(triggerConfig))}
              onChange={(v) => onChangeConfig({ hour, daysOffset: Number(v) })}
              options={OFFSET_OPTIONS}
              searchPlaceholder="Buscar…"
              ariaLabel="Momento del envío"
            />
          </Field>
        </>
      )}

      {triggerType === "stage_changed" && (
        <Field label="Etapa" htmlFor="trg-stage" hint="Déjalo en «Cualquier etapa» para que se active con cada cambio.">
          <SearchSelect
            id="trg-stage"
            value={typeof cfg.toStageId === "string" ? cfg.toStageId : ""}
            onChange={(v) => onChangeConfig(v ? { toStageId: v } : null)}
            options={stageOptions}
            emptyLabel="Cualquier etapa"
            searchPlaceholder="Buscar etapa…"
            ariaLabel="Etapa que activa el flujo"
          />
        </Field>
      )}

      {triggerType === "ad_referral" && (
        <Field label="Anuncio, conjunto o campaña" htmlFor="trg-ad" hint="Sin elegir, se activa con cualquier anuncio.">
          <AdTriggerPicker
            id="trg-ad"
            value={adCfg}
            onChange={(next) => onChangeConfig(adScopeOf(next).level === "any" ? null : { ...next })}
          />
        </Field>
      )}
    </div>
  );
}
