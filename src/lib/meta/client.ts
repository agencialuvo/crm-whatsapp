import { getEnv } from "@/lib/env";

/**
 * Cliente propio de la Graph API de Meta (WhatsApp Cloud API).
 * Única frontera de salida hacia Meta (Constitución II): todo request pasa
 * por graphRequest. En self-test, META_GRAPH_BASE_URL apunta al wa-mock.
 */

export class MetaApiError extends Error {
  status: number;
  code: number | null;
  type: string | null;
  details: unknown;
  /**
   * 041 — El tiempo se agotó SIN respuesta: Meta pudo haber aceptado la petición.
   * Un error de conexión (DNS, rechazo) no lo es: ahí seguro no salió nada.
   */
  ambiguous: boolean;

  constructor(
    message: string,
    opts: {
      status: number;
      code?: number | null;
      type?: string | null;
      details?: unknown;
      ambiguous?: boolean;
    }
  ) {
    super(message);
    this.name = "MetaApiError";
    this.status = opts.status;
    this.code = opts.code ?? null;
    this.type = opts.type ?? null;
    this.details = opts.details;
    this.ambiguous = opts.ambiguous ?? false;
  }

  /**
   * Token vencido/revocado → la conexión requiere re-autenticación.
   * Meta etiqueta como "OAuthException" también errores transitorios 5xx
   * (ej. código 2 "service temporarily unavailable"), así que el type por sí
   * solo NO basta: solo 401 o código 190, y jamás con status ≥ 500.
   */
  get isAuthError(): boolean {
    if (this.status >= 500) return false;
    return this.status === 401 || this.code === 190;
  }
}

/** 041 — Tiempo máximo de una llamada que ENVÍA (POST); las lecturas esperan el doble. */
const SEND_TIMEOUT_MS = 30_000;

function timeoutFor(method: string, override?: number): number {
  if (override !== undefined) return override;
  const fromEnv = Number(process.env.META_GRAPH_TIMEOUT_MS); // perilla de pruebas
  const send = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : SEND_TIMEOUT_MS;
  return method === "POST" ? send : send * 2;
}

function isTimeout(cause: unknown): boolean {
  const name = (cause as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

const TIMEOUT_MESSAGE =
  "Meta no respondió a tiempo: el mensaje pudo haber salido. Verifica en la conversación o en Meta antes de reenviarlo";

export async function graphRequest<T>(
  path: string,
  opts: {
    method?: "GET" | "POST" | "DELETE";
    token: string;
    body?: unknown;
    /**
     * Recibe las cabeceras de la respuesta, éxito o error (038: los
     * indicadores de uso de la Marketing API). Opcional: el resto de los
     * llamadores no cambia.
     */
    onHeaders?: (headers: Headers) => void;
    /** 041 — Tiempo máximo en ms; por omisión 30 s al enviar y 60 s al leer. */
    timeoutMs?: number;
  }
): Promise<T> {
  const env = getEnv();
  const url = `${env.META_GRAPH_BASE_URL}/${env.META_GRAPH_API_VERSION}/${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        ...(opts.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(timeoutFor(opts.method ?? "GET", opts.timeoutMs)),
    });
  } catch (cause) {
    if (isTimeout(cause)) {
      throw new MetaApiError(TIMEOUT_MESSAGE, {
        status: 0,
        details: cause,
        ambiguous: true,
      });
    }
    throw new MetaApiError("No se pudo contactar la API de Meta", {
      status: 0,
      details: cause,
    });
  }

  try {
    opts.onHeaders?.(res.headers);
  } catch {
    // un observador de cabeceras nunca rompe la llamada
  }

  let text: string;
  try {
    text = await res.text();
  } catch (cause) {
    // Las cabeceras llegaron y el cuerpo no: igual de ambiguo si se agotó el tiempo.
    throw new MetaApiError(isTimeout(cause) ? TIMEOUT_MESSAGE : "Se cortó la respuesta de Meta", {
      status: 0,
      details: cause,
      ambiguous: isTimeout(cause),
    });
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // respuesta no-JSON: se conserva el texto crudo en details
  }

  if (!res.ok) {
    const err = (json as { error?: { message?: string; code?: number; type?: string } })
      ?.error;
    throw new MetaApiError(err?.message ?? `Meta respondió ${res.status}`, {
      status: res.status,
      code: err?.code ?? null,
      type: err?.type ?? null,
      details: json ?? text,
    });
  }
  return json as T;
}

// La normalización de teléfonos es pura y vive en `lib/phone-normalize.ts` (la usa también el navegador);
// se reexporta aquí para que nadie que ya importaba de este módulo tenga que cambiar.
export { normalizeMx, normalizeRecipient } from "@/lib/phone-normalize";
