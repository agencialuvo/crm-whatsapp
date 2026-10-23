"use client";

import type { ZodIssue } from "zod";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { currencySymbol } from "@/lib/salon/format";
import { cn } from "@/lib/utils";

/** Etiqueta + control + pista o error, con el espaciado de los demás formularios. */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  /** Campo obligatorio: la etiqueta lleva un asterisco rojo. */
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor} required={required}>
        {label}
      </Label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-text-3">{hint}</p>
      ) : null}
    </div>
  );
}

/** Solo dígitos y un punto decimal, con 2 decimales como máximo ("12.50"). */
export function sanitizeDecimal(raw: string): string {
  const text = raw.replace(",", ".").replace(/[^\d.]/g, "");
  const dot = text.indexOf(".");
  if (dot === -1) return text;
  return `${text.slice(0, dot)}.${text.slice(dot + 1).replace(/\./g, "").slice(0, 2)}`;
}

/** Celular peruano de 9 dígitos con espacios: "987654321" → "987 654 321". */
export function formatPhone9(digits: string): string {
  return digits.replace(/\D/g, "").slice(0, 9).replace(/(\d{3})(?=\d)/g, "$1 ");
}

/**
 * Celular de 9 dígitos con +51 fijo, escrito como «999 999 999». El estado de
 * quien lo usa guarda solo los dígitos ("987654321").
 */
export function PhoneInput({
  id,
  digits,
  onChange,
  onBlur,
  disabled,
  invalid,
}: {
  id: string;
  digits: string;
  onChange: (digits: string) => void;
  /** Al perder el foco: el momento de avisar si quedó incompleto. */
  onBlur?: () => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <div className="flex">
      <span
        aria-hidden
        className="inline-flex items-center rounded-l-md border border-r-0 border-input bg-subtle px-2.5 text-sm text-text-2"
      >
        +51
      </span>
      <Input
        id={id}
        type="tel"
        inputMode="numeric"
        value={formatPhone9(digits)}
        placeholder="999 999 999"
        autoComplete="off"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 9))}
        onBlur={onBlur}
        className="rounded-l-none"
      />
    </div>
  );
}

/** Minutos → "HH:MM" para un `<input type="time">`; vacío si no es un número. */
export function minutesToTime(minutes: string): string {
  const n = Number(minutes);
  if (!minutes.trim() || !Number.isFinite(n) || n < 0 || n >= 24 * 60) return "";
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "HH:MM" → minutos como texto; vacío si el campo está incompleto. */
export function timeToMinutes(time: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return "";
  return String(Number(match[1]) * 60 + Number(match[2]));
}

/**
 * Duración como hora (`HH:MM`): 00:30 son 30 minutos, 01:30 una hora y media.
 * El estado de quien lo usa sigue siendo «minutos» (texto), igual que antes.
 */
export function DurationInput({
  id,
  minutes,
  onChange,
  disabled,
  invalid,
}: {
  id: string;
  minutes: string;
  onChange: (minutes: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <Input
      id={id}
      type="time"
      step={300}
      min="00:05"
      max="10:00"
      value={minutesToTime(minutes)}
      onChange={(e) => onChange(timeToMinutes(e.target.value))}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      className="w-40"
    />
  );
}

/** Campo de monto: el símbolo de la moneda del negocio delante, número decimal. */
export function MoneyInput({
  id,
  value,
  onChange,
  currency,
  disabled,
  invalid,
  readOnly,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  currency: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Se ve y se envía, pero no se edita (a diferencia de `disabled`). */
  readOnly?: boolean;
}) {
  return (
    <div className="flex">
      <span
        aria-hidden
        className="inline-flex min-w-9 items-center justify-center rounded-l-md border border-r-0 border-input bg-subtle px-2 text-sm text-text-2"
      >
        {currencySymbol(currency)}
      </span>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(sanitizeDecimal(e.target.value))}
        className={readOnly ? "rounded-l-none bg-subtle text-text-2" : "rounded-l-none"}
      />
    </div>
  );
}

/** Issues de Zod → `{ campo: primer mensaje }` para pintar cada error bajo su campo. */
export function fieldErrors(issues: ZodIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "_");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/** Un entero de un campo de texto; vacío o basura ⇒ `NaN` (el esquema lo rechaza con su mensaje). */
export function toInt(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text.trim());
}
