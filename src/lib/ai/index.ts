import type { z } from "zod";
import { chatCompletionsUrl } from "@/lib/ai/presets";
import { isMockEnabled } from "@/lib/env";
import { validatePublicHttpUrl } from "@/lib/net-guard";
import {
  resolveAiProvider,
  type AiProvider,
  type EstadoIa,
} from "@/lib/ai/provider";
import { marcarEstadoPorRespuesta } from "@/server/ai/credentials";
import { recordUsage } from "@/server/credits";

/**
 * Adaptador LLM OpenRouter-compatible — ÚNICA frontera con el proveedor de IA
 * (Constitución II). Regla operativa: la salida del modelo es impredecible;
 * todo consumo pasa por extracción robusta + Zod + reintentos, y un hipo del
 * proveedor jamás propaga excepción (resultado `error` tipado).
 *
 * Con quién habla lo decide `lib/ai/provider.ts`: la fila de Ajustes → IA de
 * la organización, y si no hay, las variables `OPENROUTER_*` del entorno.
 */

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * Monedas — lo que costó la llamada, sumando los reintentos. Opcional: quien no lo lee (y los mocks de las
 * pruebas) no se entera. `estimated` = el proveedor no informó tokens y se calcularon por longitud.
 */
export type AiUsageMeta = {
  /** De quién es la llave con la que se pagó: solo `env` consume monedas. */
  source: "org" | "env";
  model: string;
  tokensIn: number;
  tokensOut: number;
  estimated: boolean;
  /** Llamadas al proveedor que devolvieron una respuesta (cada una se midió). */
  attempts: number;
};

/** Cómo se mide una llamada. Sin esto `chatJson` no registra nada (no hay a quién atribuirlo). */
export type ChatUsageOpts = {
  /** `ai_lab` = Laboratorio y juez: se mide, nunca se cobra. */
  service: "ai" | "ai_lab";
  conversationId?: string | null;
  refType?: string | null;
  refId?: string | null;
  /** Misma clave = misma llamada lógica: un reintento del turno no duplica la medición. Cada intento añade `#n`. */
  key?: string | null;
  /** Lo que se va a cobrar si la respuesta es válida y la llave es del entorno. Solo se ANOTA aquí; descontar es del llamador. */
  chargeUnits?: number;
  /** Con el corte activo esta llamada se habría bloqueado (modo sombra). */
  wouldCut?: boolean;
};

export type ChatJsonResult<T> =
  | { ok: true; data: T; raw: string; meta?: AiUsageMeta }
  | {
      ok: false;
      error: "not_configured" | "provider_error" | "invalid_output";
      detail: string;
      meta?: AiUsageMeta;
    };

type ProviderUsage = { tokensIn: number; tokensOut: number };

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

/** El proveedor contestó con un código HTTP de error. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    body: string
  ) {
    super(`proveedor respondió ${status}: ${truncate(body)}`);
    this.name = "ProviderHttpError";
  }
}

export async function chatJson<T>(
  schema: z.ZodType<T>,
  messages: ChatMessage[],
  opts?: {
    model?: string;
    judge?: boolean;
    timeoutMs?: number;
    /**
     * De quién es la configuración con la que se paga esta llamada. Sin ella
     * solo cuenta el entorno: no hay fila que consultar ni que pausar.
     */
    organizationId?: string;
    /** Monedas: cómo medir esta llamada. */
    usage?: ChatUsageOpts;
  }
): Promise<ChatJsonResult<T>> {
  const resolved = await resolveAiProvider(opts?.organizationId);
  if (!resolved.ok) {
    return {
      ok: false,
      error: "not_configured",
      detail: detalleNoConfigurado(resolved.estado),
    };
  }
  const provider = resolved.provider;
  const model =
    opts?.model ?? (opts?.judge ? provider.judgeModel : provider.model);
  if (!model?.trim()) {
    return {
      ok: false,
      error: "not_configured",
      detail: "Sin modelo configurado (Ajustes → IA u OPENROUTER_MODEL)",
    };
  }

  let lastDetail = "";
  const total: AiUsageMeta = { source: provider.source, model, tokensIn: 0, tokensOut: 0, estimated: false, attempts: 0 };
  const meta = (): AiUsageMeta | undefined => (total.attempts > 0 ? { ...total } : undefined);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const attemptMessages: ChatMessage[] =
      attempt === 1
        ? messages
        : [
            ...messages,
            {
              role: "system",
              content:
                "STRICT: tu respuesta anterior no fue JSON válido según el esquema. Responde ÚNICAMENTE el objeto JSON, sin explicaciones ni markdown.",
            },
          ];
    try {
      const call = await callProvider(
        provider,
        model,
        attemptMessages,
        opts?.timeoutMs
      );
      const raw = call.content;
      // Tokens: lo que informó el proveedor o, si no informó nada, una estimación por longitud (≈4 caracteres/token).
      const tokens = call.usage ?? {
        tokensIn: estimateTokens(attemptMessages.map((m) => m.content).join("\n")),
        tokensOut: estimateTokens(raw),
      };
      total.attempts += 1;
      total.tokensIn += tokens.tokensIn;
      total.tokensOut += tokens.tokensOut;
      if (!call.usage) total.estimated = true;
      const extracted = extractJson(raw);
      if (extracted === null) {
        await medirIntento(opts, provider, model, attempt, tokens, !call.usage, false);
        lastDetail = `sin JSON extraíble (raw=${truncate(raw)})`;
        continue;
      }
      const parsed = schema.safeParse(extracted);
      if (!parsed.success) {
        await medirIntento(opts, provider, model, attempt, tokens, !call.usage, false);
        lastDetail = `no cumple el esquema: ${parsed.error.issues
          .map((i) => i.path.join(".") + " " + i.message)
          .join("; ")} (raw=${truncate(raw)})`;
        continue;
      }
      await medirIntento(opts, provider, model, attempt, tokens, !call.usage, true);
      return { ok: true, data: parsed.data, raw, meta: meta() };
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
      /**
       * El estado de la credencial lo dicta QUIEN COBRA, no la UI.
       *
       * Si el proveedor dijo 401 o 402 sobre la llave guardada en Ajustes → IA,
       * la credencial queda pausada y se deja de intentar: reintentar una
       * llave que el proveedor rechaza solo gasta tiempo, y el turno ya está
       * perdido. Un 429 o un 500 NO pausan (ver `estadoSegunRespuesta`), así
       * que ahí sí se reintenta. La llave del entorno no tiene fila que
       * pausar: ahí se reintenta como siempre.
       */
      if (
        err instanceof ProviderHttpError &&
        provider.source === "org" &&
        opts?.organizationId
      ) {
        const pausada = await marcarEstadoPorRespuesta(
          opts.organizationId,
          err.status,
          lastDetail
        ).catch(() => false);
        if (pausada) break;
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  return {
    ok: false,
    error: lastDetail.includes("esquema") || lastDetail.includes("JSON")
      ? "invalid_output"
      : "provider_error",
    detail: lastDetail,
    meta: meta(),
  };
}

/** ≈4 caracteres por token: una estimación honrada y marcada como tal, solo cuando el proveedor no informa. */
function estimateTokens(text: string): number {
  return Math.max(Math.ceil(text.length / 4), 1);
}

/**
 * Monedas — anota un intento en `credit_usage`. NUNCA lanza ni retrasa de más: medir es secundario a contestar, y con
 * `CREDITS` apagada `recordUsage` ni toca la base. Solo la llamada que dio una respuesta válida con llave del entorno
 * lleva `chargedUnits`: es la que el llamador descuenta.
 */
async function medirIntento(
  opts: { organizationId?: string; usage?: ChatUsageOpts } | undefined,
  provider: AiProvider,
  model: string,
  attempt: number,
  tokens: ProviderUsage,
  estimated: boolean,
  valid: boolean
): Promise<void> {
  const u = opts?.usage;
  if (!u || !opts?.organizationId) return;
  try {
    await recordUsage({
      organizationId: opts.organizationId,
      service: u.service,
      source: provider.source,
      model,
      tokensIn: tokens.tokensIn,
      tokensOut: tokens.tokensOut,
      estimated,
      conversationId: u.conversationId ?? null,
      refType: u.refType ?? null,
      refId: u.refId ?? null,
      chargedUnits: valid && u.service === "ai" && provider.source === "env" ? (u.chargeUnits ?? 0) : 0,
      wouldCut: u.wouldCut ?? false,
      idempotencyKey: u.key ? `${u.key}#${attempt}` : null,
      meta: { attempt, valid },
    });
  } catch (err) {
    console.error("[monedas] no se pudo medir la llamada a la IA:", err instanceof Error ? err.message : err);
  }
}

function detalleNoConfigurado(estado: Exclude<EstadoIa, { activa: true }>): string {
  switch (estado.motivo) {
    case "sin_configurar":
      return "Sin proveedor de IA: configúralo en Ajustes → IA (u OPENROUTER_API_TOKEN en el entorno)";
    case "token_invalido":
      return `La llave de IA (…${estado.last4}) está pausada: el proveedor la rechazó`;
    case "sin_saldo":
      return `La llave de IA (…${estado.last4}) está pausada: la cuenta no tiene saldo`;
  }
}

async function callProvider(
  provider: AiProvider,
  model: string,
  messages: ChatMessage[],
  timeoutMs = 60_000
): Promise<{ content: string; usage?: ProviderUsage }> {
  // La base URL de una ORGANIZACIÓN la escribió quien configura: se revalida aquí (puede venir de antes de la guarda).
  // La del entorno la fija quien opera el servidor y puede ser local.
  if (provider.source === "org") {
    const bad = validatePublicHttpUrl(chatCompletionsUrl(provider.baseUrl), { allowLocal: isMockEnabled() });
    if (bad) throw new Error(bad);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(chatCompletionsUrl(provider.baseUrl), {
      method: "POST",
      headers: {
        // El token jamás se loguea; solo viaja en este header.
        Authorization: `Bearer ${provider.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderHttpError(res.status, text);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("respuesta del proveedor sin contenido");
    }
    // OpenRouter y compatibles informan `usage`; si falta o no es numérico, quien llama estima.
    const pin = Number(json.usage?.prompt_tokens);
    const pout = Number(json.usage?.completion_tokens);
    const usage =
      Number.isFinite(pin) && Number.isFinite(pout) && (pin > 0 || pout > 0)
        ? { tokensIn: Math.floor(pin), tokensOut: Math.floor(pout) }
        : undefined;
    return { content, usage };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extracción robusta de JSON de una respuesta de modelo:
 * 1) bloque ```json ... ``` (o ``` ... ```), 2) el texto completo,
 * 3) del primer `{` al último `}`.
 */
export function extractJson(raw: string): unknown | null {
  const candidates: string[] = [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(raw.trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(raw.slice(first, last + 1));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // siguiente candidato
    }
  }
  return null;
}

function truncate(s: string, n = 300): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
