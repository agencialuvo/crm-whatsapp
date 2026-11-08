/**
 * Módulo SALON — cliente de la API interna para las pantallas.
 *
 * Una sola forma de pedir y de fallar: todo error llega como `ApiError` con un
 * mensaje que ya se puede enseñar a la persona (el de la API si lo trae, uno
 * claro si no hubo red).
 */

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Init = Omit<RequestInit, "body"> & { json?: unknown };

export async function apiFetch<T>(url: string, init: Init = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: {
        ...(json !== undefined && { "content-type": "application/json" }),
        ...headers,
      },
      ...(json !== undefined && { body: JSON.stringify(json) }),
    });
  } catch (err) {
    // Una petición cancelada a propósito no es un error que mostrar.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError("No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.", 0, "network");
  }

  const body = (await res.json().catch(() => null)) as
    | (T & { error?: { code?: string; message?: string } })
    | null;

  if (!res.ok) {
    if (res.status === 401) {
      throw new ApiError("Tu sesión expiró. Vuelve a iniciar sesión.", 401, "unauthorized");
    }
    if (res.status === 403) {
      throw new ApiError("Solo el dueño o un administrador puede hacer esto.", 403, "forbidden");
    }
    throw new ApiError(
      body?.error?.message ?? "No se pudo completar la acción. Inténtalo de nuevo.",
      res.status,
      body?.error?.code ?? "unknown"
    );
  }
  return body as T;
}

/** Texto para mostrar de cualquier error capturado. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Ocurrió un error inesperado. Inténtalo de nuevo.";
}

/** El código HTTP de un error de la API (`404`, `409`…), o `null` si no vino de ella (sin red, error propio). */
export function apiErrorStatus(err: unknown): number | null {
  return err instanceof ApiError ? err.status : null;
}
