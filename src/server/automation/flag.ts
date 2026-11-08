/**
 * Automatizaciones — si esta instancia ejecuta flujos automáticos.
 *
 * Mismo trato que la agenda (ADR-002): el código viaja siempre en `main` y lo que decide si EXISTE
 * es una variable de despliegue, apagada por defecto. Apagada, el worker no arranca y la cola no se
 * toca; la migración se aplica igual (unas tablas vacías son inertes).
 *
 * Se lee de `process.env` directo, no por `getEnv()`: preguntar si una feature existe no puede
 * depender de que TODO el entorno valide.
 */

const ON_VALUES = new Set(["on", "1", "true", "si", "sí", "yes"]);

export function parseAutomationsFlag(raw: string | undefined): boolean {
  return ON_VALUES.has((raw ?? "").trim().toLowerCase());
}

export function automationsEnabled(): boolean {
  return parseAutomationsFlag(process.env.AUTOMATIONS);
}
