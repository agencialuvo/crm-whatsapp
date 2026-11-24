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

/**
 * Paso 3 — el bloque «Código JavaScript». Una bandera de plataforma APARTE de `AUTOMATIONS`, apagada por defecto: ejecuta
 * código escrito por un cliente dentro del servidor compartido (aislado en un intérprete WASM, ver `sandbox.ts`), y esa
 * superficie se enciende a propósito. Apagada, no se pueden guardar bloques de código y los que hubiera fallan a la vista.
 * Ej.: AUTOMATION_CODE_JS=on
 */
export function codeJsEnabled(): boolean {
  return parseAutomationsFlag(process.env.AUTOMATION_CODE_JS);
}
