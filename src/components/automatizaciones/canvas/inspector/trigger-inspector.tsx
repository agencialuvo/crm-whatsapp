"use client";

import { useMemo } from "react";
import { Input } from "@/components/ui/input";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";
import { AdTriggerPicker } from "@/components/automatizaciones/ad-trigger-picker";
import { Field } from "@/components/negocio/fields";
import { BIRTHDAY_DEFAULT_HOUR, adScopeOf, loyaltyHitoWarning, loyaltyMilestoneLabel, parseAdReferralConfig } from "@/lib/automation";
import { useLoyaltyMilestones } from "@/components/automatizaciones/use-loyalty-milestones";
import {
  BIRTHDAY_OFFSETS,
  CREATABLE_TRIGGERS,
  TRIGGER_HINTS,
  hourLabel,
  offsetOf,
  offsetOptionLabel,
  triggerLabel,
  type StageOption,
  type TagOption,
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
  tags = [],
  onChangeType,
  onChangeConfig,
}: {
  triggerType: string;
  triggerConfig: Record<string, unknown> | null;
  stages: StageOption[];
  tags?: TagOption[];
  onChangeType: (type: string) => void;
  onChangeConfig: (config: Record<string, unknown> | null) => void;
}) {
  const cfg = triggerConfig ?? {};
  const stageOptions = useMemo<SearchSelectOption[]>(() => stages.map((s) => ({ value: s.id, label: s.name })), [stages]);

  const tagOptions = useMemo<SearchSelectOption[]>(() => tags.map((t) => ({ value: t.id, label: t.name })), [tags]);

  // 047 — A qué reacciona el disparador de anuncio: cualquiera, un anuncio, un conjunto o una campaña (solo IDs).
  const adCfg = parseAdReferralConfig(triggerConfig);

  const hint = (CREATABLE_TRIGGERS as readonly string[]).includes(triggerType) ? TRIGGER_HINTS[triggerType as keyof typeof TRIGGER_HINTS] : null;
  const hour = typeof cfg.hour === "number" ? cfg.hour : BIRTHDAY_DEFAULT_HOUR;

  // «Premio de fidelidad»: los hitos reales del programa (null = no cargaron: queda el campo numérico).
  const milestones = useLoyaltyMilestones(triggerType === "loyalty_reward_unlocked");
  const premio = typeof cfg.stamps === "number" ? cfg.stamps : null;
  const milestoneOptions = useMemo<SearchSelectOption[]>(() => {
    if (!milestones) return [];
    const opts = milestones.map((m) => ({ value: String(m.stamps), label: loyaltyMilestoneLabel(m) }));
    if (premio && !opts.some((o) => o.value === String(premio))) opts.push({ value: String(premio), label: `Sello ${premio} · (ya no existe)` });
    return opts;
  }, [milestones, premio]);
  const hitoWarning = milestones ? loyaltyHitoWarning(premio, milestones) : null;

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

      {triggerType === "tag_added" && (
        <Field label="Etiqueta" htmlFor="trg-tag" hint="Déjalo en «Cualquier etiqueta» para que se active con todas.">
          <SearchSelect
            id="trg-tag"
            value={typeof cfg.tagId === "string" ? cfg.tagId : ""}
            onChange={(v) => onChangeConfig(v ? { tagId: v } : null)}
            options={tagOptions}
            emptyLabel="Cualquier etiqueta"
            searchPlaceholder="Buscar etiqueta…"
            ariaLabel="Etiqueta que activa el flujo"
          />
        </Field>
      )}

      {triggerType === "loyalty_reward_unlocked" && (
        <Field
          label="Premio (sellos)"
          htmlFor="trg-stamps"
          hint={milestones ? "Elige un premio de tu programa, o «Cualquier premio»." : "Los sellos del premio, por ejemplo 8. Vacío: cualquier premio."}
        >
          {milestones ? (
            <SearchSelect
              id="trg-stamps"
              value={premio ? String(premio) : ""}
              onChange={(v) => onChangeConfig(v ? { stamps: Number(v) } : null)}
              options={milestoneOptions}
              emptyLabel="Cualquier premio"
              searchPlaceholder="Buscar premio…"
              ariaLabel="Premio que activa el flujo"
            />
          ) : (
            <Input
              id="trg-stamps"
              inputMode="numeric"
              maxLength={4}
              placeholder="Cualquier premio"
              value={typeof cfg.stamps === "number" ? String(cfg.stamps) : ""}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, "");
                onChangeConfig(digits ? { stamps: Number(digits) } : null);
              }}
            />
          )}
          {hitoWarning && (
            <p role="alert" className="mt-1.5 rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
              {hitoWarning}
            </p>
          )}
        </Field>
      )}

      {triggerType === "loyalty_stamp_earned" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Exactamente en el sello" htmlFor="trg-stamp-exact" hint="Solo al llegar a esos sellos. Vacío: cualquiera.">
            <Input
              id="trg-stamp-exact"
              inputMode="numeric"
              maxLength={4}
              placeholder="Cualquiera"
              value={typeof cfg.stamps === "number" ? String(cfg.stamps) : ""}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, "");
                const { stamps: _omit, ...rest } = cfg as Record<string, unknown>;
                void _omit;
                const next = { ...rest, ...(digits ? { stamps: Number(digits) } : {}) };
                onChangeConfig(Object.keys(next).length ? next : null);
              }}
            />
          </Field>
          <Field label="Desde el sello" htmlFor="trg-stamp-min" hint="Con cada sello desde ese número. Vacío: desde el primero.">
            <Input
              id="trg-stamp-min"
              inputMode="numeric"
              maxLength={4}
              placeholder="Desde el primero"
              value={typeof cfg.minStamps === "number" ? String(cfg.minStamps) : ""}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, "");
                const { minStamps: _omit, ...rest } = cfg as Record<string, unknown>;
                void _omit;
                const next = { ...rest, ...(digits ? { minStamps: Number(digits) } : {}) };
                onChangeConfig(Object.keys(next).length ? next : null);
              }}
            />
          </Field>
        </div>
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
