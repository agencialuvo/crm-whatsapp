/**
 * Medios — aviso al optimizador de que hay un video nuevo en la cola. Vive aparte para que el almacén (`store.ts`) pueda
 * avisar sin importar al trabajador (que a su vez importa el almacén). Sin trabajador arrancado no hace nada: la cola es
 * la tabla, y el trabajador recoge lo pendiente en su siguiente ronda.
 */
const g = globalThis as unknown as { __voceroDespertarOptimizador?: () => void };

export function registrarDespertar(fn: (() => void) | null): void {
  if (fn) g.__voceroDespertarOptimizador = fn;
  else delete g.__voceroDespertarOptimizador;
}

export function despertarOptimizador(): void {
  try {
    g.__voceroDespertarOptimizador?.();
  } catch {
    // Avisar nunca debe romper una subida.
  }
}
