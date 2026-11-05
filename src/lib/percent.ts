/** Los porcentajes del sistema van de 0 a 100, enteros. */
export const PERCENT_MIN = 0;
export const PERCENT_MAX = 100;

/**
 * Limpia lo que se escribe en un campo de porcentaje: solo dígitos (sin signo menos, punto ni «e»),
 * sin ceros a la izquierda y nunca más de 100. Vacío sigue vacío (en varios campos «vacío» significa
 * «usar la regla de siempre»). Úsala en el `onChange` de TODO campo de porcentaje.
 */
export function clampPercent(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits === "") return "";
  return String(Math.min(PERCENT_MAX, Number(digits.slice(0, 4))));
}
