import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSWASMModule } from "quickjs-emscripten";
import { CODE_JS_MAX_CHARS } from "@/lib/automation";

/**
 * Automatizaciones — el sandbox del bloque «Código JavaScript».
 *
 * El código lo escribe un CLIENTE y corre dentro del servidor compartido, así que NO se evalúa con `node:vm` (que no es
 * una barrera de seguridad) sino en QuickJS compilado a WASM: un intérprete de JavaScript aparte, sin `process`, `require`,
 * `fetch`, sistema de archivos, temporizadores ni nada de Node. Lo único que entra es un JSON (`input`) y lo único que
 * sale es otro JSON (`{ vars }`); no hay puente a funciones del anfitrión, y por tanto ni secretos (`process.env`), ni base
 * de datos, ni red. Cada ejecución crea su propio runtime y lo destruye: nada se comparte entre ejecuciones.
 *
 * Topes duros: tiempo (un bucle infinito se corta por el *interrupt handler*), memoria, pila, y tamaño de entrada y de
 * salida. QuickJS corre en el hilo principal: el tope de tiempo es también lo máximo que una ejecución puede ocupar el
 * bucle de eventos, por eso es corto y hay un máximo de bloques de código por flujo.
 *
 * Determinista: `Math.random` y `Date` se anulan (la hora entra como `input.now`), así reintentar el paso da lo mismo.
 */

export const CODE_SANDBOX_LIMITS = {
  timeoutMs: 500,
  memoryBytes: 8 * 1024 * 1024,
  stackBytes: 256 * 1024,
  inputMaxChars: 16_000,
  outputMaxChars: 8_000,
} as const;

/** Por qué falló una ejecución. TODOS son definitivos: el código y sus datos no cambian solos, reintentar solo gasta intentos. */
export type CodeFailure = "code_error" | "code_timeout" | "code_memory" | "code_input_too_large" | "code_output_invalid" | "code_js_disabled";

export type CodeRunResult =
  | { ok: true; vars: Record<string, unknown>; durationMs: number; outputChars: number }
  | { ok: false; code: CodeFailure; message: string };

let quickjs: Promise<QuickJSWASMModule> | null = null;
const loadQuickJS = (): Promise<QuickJSWASMModule> => (quickjs ??= getQuickJS());

const clip = (s: string, max = 300) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** Antes del código del cliente: sin azar ni reloj (el resultado debe ser el mismo en cada intento). */
const PRELUDE = `"use strict";
Math.random = function () { throw new Error("Math.random no está disponible: el resultado debe ser repetible"); };
globalThis.Date = function () { throw new Error("Date no está disponible: usa input.now"); };
`;

/** Valida lo que devolvió el código: `{ vars?: { clave: texto | número | sí/no | null } }` y nada más. */
function parseOutput(text: string): { ok: true; vars: Record<string, unknown> } | { ok: false; message: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: "El resultado no es JSON válido" };
  }
  if (value === null) return { ok: true, vars: {} };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "Devuelve un objeto: { vars: { clave: valor } }" };
  const out = value as Record<string, unknown>;
  const extra = Object.keys(out).filter((k) => k !== "vars");
  if (extra.length > 0) return { ok: false, message: `Solo se admite «vars» en el resultado (sobra: ${extra.slice(0, 3).join(", ")})` };
  const vars = out.vars ?? {};
  if (typeof vars !== "object" || vars === null || Array.isArray(vars)) return { ok: false, message: "«vars» debe ser un objeto { clave: valor }" };
  for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
    if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      return { ok: false, message: `El valor de «${k.slice(0, 40)}» debe ser texto, número, sí/no o null` };
    }
  }
  return { ok: true, vars: vars as Record<string, unknown> };
}

/**
 * Ejecuta `code` (el cuerpo de una función que recibe `input` y devuelve `{ vars }`) con topes. Nunca lanza: todo fallo es
 * un `CodeRunResult` tipado.
 */
export async function runSandboxedCode(params: { code: string; input: unknown }): Promise<CodeRunResult> {
  const { code, input } = params;
  if (code.length > CODE_JS_MAX_CHARS) return { ok: false, code: "code_error", message: `El código supera ${CODE_JS_MAX_CHARS} caracteres` };
  const inputJson = JSON.stringify(input ?? null);
  if (inputJson.length > CODE_SANDBOX_LIMITS.inputMaxChars) {
    return { ok: false, code: "code_input_too_large", message: "Los datos de entrada del bloque de código son demasiado grandes" };
  }

  const started = Date.now();
  let runtime: ReturnType<QuickJSWASMModule["newRuntime"]> | null = null;
  try {
    const mod = await loadQuickJS();
    runtime = mod.newRuntime();
    runtime.setMemoryLimit(CODE_SANDBOX_LIMITS.memoryBytes);
    runtime.setMaxStackSize(CODE_SANDBOX_LIMITS.stackBytes);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + CODE_SANDBOX_LIMITS.timeoutMs));
    const vm = runtime.newContext();
    try {
      // El JSON entra como literal de texto (doble `stringify`): el dato nunca se interpreta como código.
      const program = `${PRELUDE}const __out = (function (input) {\n${code}\n})(JSON.parse(${JSON.stringify(inputJson)}));\nJSON.stringify(__out === undefined ? null : __out);`;
      const result = vm.evalCode(program, "bloque-codigo.js");
      if (result.error) {
        const err = vm.dump(result.error) as { name?: unknown; message?: unknown } | string;
        result.error.dispose();
        const name = typeof err === "object" && err ? String(err.name ?? "Error") : "Error";
        const message = typeof err === "object" && err ? String(err.message ?? "") : String(err);
        if (/interrupted/i.test(message)) return { ok: false, code: "code_timeout", message: `El código tardó más de ${CODE_SANDBOX_LIMITS.timeoutMs} ms` };
        if (/out of memory/i.test(message)) return { ok: false, code: "code_memory", message: "El código usó demasiada memoria" };
        return { ok: false, code: "code_error", message: clip(`${name}: ${message}`) };
      }
      const text = vm.dump(result.value);
      result.value.dispose();
      if (typeof text !== "string") return { ok: false, code: "code_output_invalid", message: "El código no devolvió un resultado" };
      if (text.length > CODE_SANDBOX_LIMITS.outputMaxChars) {
        return { ok: false, code: "code_output_invalid", message: `El resultado supera ${CODE_SANDBOX_LIMITS.outputMaxChars} caracteres` };
      }
      const parsed = parseOutput(text);
      if (!parsed.ok) return { ok: false, code: "code_output_invalid", message: parsed.message };
      return { ok: true, vars: parsed.vars, durationMs: Date.now() - started, outputChars: text.length };
    } finally {
      vm.dispose();
    }
  } catch (err) {
    // Un fallo del propio sandbox (no del código del cliente): tampoco se reintenta, y no se vuelca el detalle interno.
    console.error("[automatizaciones] el sandbox de código falló:", err);
    return { ok: false, code: "code_error", message: "No se pudo ejecutar el bloque de código" };
  } finally {
    runtime?.dispose();
  }
}
