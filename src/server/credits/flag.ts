/**
 * Monedas — si esta instancia las usa o no.
 *
 * Misma decisión que los canales y módulos opcionales (ADR-001): el código viaja siempre en main, y lo que decide
 * si EXISTE es una variable de despliegue. Con `CREDITS` apagada (lo normal) nada se mide, nada se descuenta, nada
 * se corta y ninguna consulta nueva toca la base: el sistema se comporta exactamente como antes de las monedas. Las
 * tablas se crean siempre (una tabla vacía es inerte).
 *
 * Encendida, arranca en MODO SOMBRA: la contabilidad es completa pero ninguna organización se corta hasta que se
 * activa `credit_account.cut_enabled` en ella, con las tarifas ya calibradas.
 *
 * Se lee de `process.env` directo, no por `getEnv()` (igual que `agendaEnabled()`): preguntar si una feature existe
 * no puede depender de que TODO el entorno valide.
 */

const ON_VALUES = new Set(["on", "1", "true", "si", "sí", "yes"]);

export function parseCreditsFlag(raw: string | undefined): boolean {
  return ON_VALUES.has((raw ?? "").trim().toLowerCase());
}

export function creditsEnabled(): boolean {
  return parseCreditsFlag(process.env.CREDITS);
}
