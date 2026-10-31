import { formatMoneyCents } from "@/lib/money";
import { dayIsoInTz } from "@/lib/time/slots";

/**
 * Módulo SALON — formato para las pantallas. Puro: sin React ni BD.
 */

/**
 * La moneda la elige cada negocio en Ajustes → Marca; el LOCALE solo decide
 * cómo se escribe (S/ 25.00 en Perú, $25.00 en México). Una moneda sin entrada
 * aquí cae a `es-MX`, que siempre produce un número correcto.
 */
const LOCALE_BY_CURRENCY: Record<string, string> = {
  PEN: "es-PE",
  MXN: "es-MX",
  COP: "es-CO",
  CLP: "es-CL",
  ARS: "es-AR",
  UYU: "es-UY",
  BOB: "es-BO",
  PYG: "es-PY",
  CRC: "es-CR",
  GTQ: "es-GT",
  HNL: "es-HN",
  NIO: "es-NI",
  PAB: "es-PA",
  DOP: "es-DO",
  VES: "es-VE",
  USD: "es-US",
  EUR: "es-ES",
};

function moneyLocale(currency: string): string {
  return LOCALE_BY_CURRENCY[currency] ?? "es-MX";
}

/** `2500` → "S/ 25.00" (PEN). `null` → "—". */
export function money(cents: number | null | undefined, currency: string): string {
  return formatMoneyCents(cents, currency, moneyLocale(currency)) ?? "—";
}

/** El símbolo suelto ("S/", "$") para pegarlo delante de un campo de monto. */
export function currencySymbol(currency: string): string {
  try {
    const part = new Intl.NumberFormat(moneyLocale(currency), {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    })
      .formatToParts(0)
      .find((p) => p.type === "currency");
    return part?.value ?? currency;
  } catch {
    return currency;
  }
}

/** Como `dateTimeLabel` pero con el año: para listas que cruzan meses o años ("31 oct 2026, 18:05"). */
export function dateTimeFullLabel(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")} ${get("month").replace(/\.$/, "")} ${get("year")}, ${get("hour")}:${get("minute")}`;
}

/** Centavos → texto editable de un campo de monto: `2500` → "25.00". */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** "30 min", "1 h", "1 h 30 min". */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Fecha y hora de un instante EN LA ZONA DEL NEGOCIO: "17 oct, 14:30". */
export function dateTimeLabel(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")} ${get("month").replace(/\.$/, "")}, ${get("hour")}:${get("minute")}`;
}

export const MONTH_NAMES = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
] as const;

/** "15 de Marzo", o "—" si falta. */
export function birthdayLabel(day: number | null, month: number | null): string {
  if (day == null || month == null) return "—";
  const name = MONTH_NAMES[month - 1];
  return name ? `${day} de ${name}` : "—";
}

/** Una celda de CSV: comillas dobles escapadas y defensa contra fórmulas de Excel. */
export function csvCell(value: string | number): string {
  let text = String(value);
  // Una celda que empieza con = + - @ la interpreta Excel como fórmula.
  if (/^[=+\-@\t\r]/.test(text) && typeof value === "string") text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Lunes primero: así se lee la semana en un negocio de habla hispana. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const DAY_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"] as const;

export function dayShort(dayOfWeek: number): string {
  return DAY_SHORT[dayOfWeek] ?? "?";
}

/**
 * El horario de un profesional en una línea. Sin filas, sigue al negocio; las
 * filas son solo los días libres y los de horario propio.
 */
export function scheduleSummary(
  days: { dayOfWeek: number; isOff: boolean; startTime: string; endTime: string }[]
): string {
  if (days.length === 0) return "Sigue el horario del negocio";
  const order = (d: { dayOfWeek: number }) => WEEK_ORDER.indexOf(d.dayOfWeek as (typeof WEEK_ORDER)[number]);
  const sorted = [...days].sort((a, b) => order(a) - order(b));
  const off = sorted.filter((d) => d.isOff).map((d) => dayShort(d.dayOfWeek));
  const own = sorted.filter((d) => !d.isOff);
  const parts: string[] = [];
  if (off.length > 0) parts.push(`Libre: ${off.join(", ")}`);
  if (own.length === 1) {
    const d = own[0]!;
    parts.push(`${dayShort(d.dayOfWeek)} ${d.startTime}–${d.endTime}`);
  } else if (own.length > 1) {
    parts.push(`${own.length} días con horario propio`);
  }
  return parts.join(" · ");
}

/** Fecha (sin hora) de un instante EN LA ZONA DEL NEGOCIO: "20/10/2026". */
export function dateNumeric(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const [y, m, day] = dayIsoInTz(d, timezone).split("-");
  return `${day}/${m}/${y}`;
}

/**
 * Celular peruano guardado como `51912345678` → "+51 912 345 678". Lo que no
 * tiene esa forma (otro país, datos viejos) se muestra con "+" y tal cual.
 */
export function formatPeruPhone(phone: string | null | undefined): string {
  if (!phone) return "—";
  const m = /^51(\d{3})(\d{3})(\d{3})$/.exec(phone);
  return m ? `+51 ${m[1]} ${m[2]} ${m[3]}` : `+${phone}`;
}

/** Día (AAAA-MM-DD) y hora (HH:MM) de un instante EN LA ZONA DEL NEGOCIO. */
export function wallClockInTz(iso: string, timezone: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}
