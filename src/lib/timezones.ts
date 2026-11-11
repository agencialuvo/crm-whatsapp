import { isValidTimeZone } from "@/lib/time/slots";

/**
 * Zonas horarias que ofrece Ajustes → Negocio → Marca. Una lista corta y legible (por país o
 * ciudad) en vez de las ~400 zonas IANA: cubre Latinoamérica, España, Norteamérica y Europa; una
 * zona fuera de la lista (p. ej. una guardada antes en la agenda) se conserva y se muestra tal cual.
 */

export type TimezoneOption = { id: string; label: string; group: string };

const G = {
  mx: "México",
  ca: "Centroamérica",
  sa: "Sudamérica",
  cb: "Caribe",
  na: "Estados Unidos y Canadá",
  eu: "Europa",
  ot: "Otra",
} as const;

export const TIMEZONES: readonly TimezoneOption[] = [
  { id: "America/Mexico_City", label: "Ciudad de México", group: G.mx },
  { id: "America/Monterrey", label: "Monterrey", group: G.mx },
  { id: "America/Merida", label: "Mérida", group: G.mx },
  { id: "America/Cancun", label: "Cancún", group: G.mx },
  { id: "America/Chihuahua", label: "Chihuahua", group: G.mx },
  { id: "America/Mazatlan", label: "Mazatlán", group: G.mx },
  { id: "America/Hermosillo", label: "Hermosillo (Sonora)", group: G.mx },
  { id: "America/Tijuana", label: "Tijuana", group: G.mx },

  { id: "America/Guatemala", label: "Guatemala", group: G.ca },
  { id: "America/El_Salvador", label: "El Salvador", group: G.ca },
  { id: "America/Tegucigalpa", label: "Honduras", group: G.ca },
  { id: "America/Managua", label: "Nicaragua", group: G.ca },
  { id: "America/Costa_Rica", label: "Costa Rica", group: G.ca },
  { id: "America/Panama", label: "Panamá", group: G.ca },
  { id: "America/Belize", label: "Belice", group: G.ca },

  { id: "America/Bogota", label: "Colombia (Bogotá)", group: G.sa },
  { id: "America/Lima", label: "Perú (Lima)", group: G.sa },
  { id: "America/Guayaquil", label: "Ecuador (Guayaquil)", group: G.sa },
  { id: "America/Caracas", label: "Venezuela (Caracas)", group: G.sa },
  { id: "America/La_Paz", label: "Bolivia (La Paz)", group: G.sa },
  { id: "America/Santiago", label: "Chile (Santiago)", group: G.sa },
  { id: "America/Argentina/Buenos_Aires", label: "Argentina (Buenos Aires)", group: G.sa },
  { id: "America/Montevideo", label: "Uruguay (Montevideo)", group: G.sa },
  { id: "America/Asuncion", label: "Paraguay (Asunción)", group: G.sa },
  { id: "America/Sao_Paulo", label: "Brasil (São Paulo)", group: G.sa },

  { id: "America/Santo_Domingo", label: "República Dominicana", group: G.cb },
  { id: "America/Puerto_Rico", label: "Puerto Rico", group: G.cb },
  { id: "America/Havana", label: "Cuba (La Habana)", group: G.cb },
  { id: "America/Jamaica", label: "Jamaica", group: G.cb },

  { id: "America/New_York", label: "Este (Nueva York)", group: G.na },
  { id: "America/Chicago", label: "Centro (Chicago)", group: G.na },
  { id: "America/Denver", label: "Montaña (Denver)", group: G.na },
  { id: "America/Phoenix", label: "Arizona (Phoenix)", group: G.na },
  { id: "America/Los_Angeles", label: "Pacífico (Los Ángeles)", group: G.na },
  { id: "Pacific/Honolulu", label: "Hawái (Honolulu)", group: G.na },
  { id: "America/Toronto", label: "Canadá Este (Toronto)", group: G.na },
  { id: "America/Vancouver", label: "Canadá Pacífico (Vancouver)", group: G.na },

  { id: "Europe/Madrid", label: "España (Madrid)", group: G.eu },
  { id: "Atlantic/Canary", label: "España (Canarias)", group: G.eu },
  { id: "Europe/Lisbon", label: "Portugal (Lisboa)", group: G.eu },
  { id: "Europe/London", label: "Reino Unido (Londres)", group: G.eu },
  { id: "Europe/Paris", label: "Francia (París)", group: G.eu },
  { id: "Europe/Berlin", label: "Alemania (Berlín)", group: G.eu },
  { id: "Europe/Rome", label: "Italia (Roma)", group: G.eu },

  { id: "UTC", label: "UTC (hora universal)", group: G.ot },
];

/** «UTC−6» / «UTC+5:30» de una zona en un instante (DST incluido); "" si el motor no la sabe. */
export function utcOffsetLabel(timeZone: string, at: Date = new Date()): string {
  if (!isValidTimeZone(timeZone)) return "";
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  // «GMT-06:00» → «UTC−6»; «GMT» → «UTC».
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(part ?? "");
  if (!m) return "";
  if (!m[1]) return "UTC";
  const h = Number(m[2]);
  const min = m[3] === "00" ? "" : `:${m[3]}`;
  return `UTC${m[1] === "-" ? "−" : "+"}${h}${min}`;
}

/**
 * Las opciones del desplegable, con la hora UTC de cada una. Si la zona actual no está en la
 * lista, se añade al final para no perderla al abrir el formulario.
 */
export function timezoneSelectOptions(
  current: string,
  at: Date = new Date()
): { value: string; label: string; group: string; hint: string }[] {
  const known = TIMEZONES.some((t) => t.id === current);
  const all: readonly TimezoneOption[] =
    !known && current && isValidTimeZone(current)
      ? [...TIMEZONES, { id: current, label: current.replace(/_/g, " "), group: G.ot }]
      : TIMEZONES;
  return all.map((t) => ({ value: t.id, label: t.label, group: t.group, hint: utcOffsetLabel(t.id, at) }));
}
