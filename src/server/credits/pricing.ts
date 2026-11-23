import { priceUsage, type RateUnitKind } from "@/lib/credits";
import { creditsEnabled } from "./flag";
import { getRate } from "./catalog";

/**
 * Monedas — cuánto cuesta algo AHORA. Lee la tarifa vigente de `credit_rate` y la guarda 30 s en memoria: el flujo
 * pregunta en cada turno y en cada envío, y una tarifa cambia como mucho una vez al mes. Nunca lanza: sin tarifa
 * (o con la base caída) el precio es 0, que se traduce en «solo medido», jamás en cortar a alguien.
 */

const TTL_MS = 30_000;
type Entry = { at: number; rate: { unitKind: RateUnitKind; amount: number } | null };
const g = globalThis as unknown as { __creditRateCache?: Map<string, Entry> };
const cache = (): Map<string, Entry> => (g.__creditRateCache ??= new Map());

/** Vacía la caché (pruebas, y después de `setRate`). */
export function clearRateCache(): void {
  cache().clear();
}

async function rateOf(key: string): Promise<Entry["rate"]> {
  const hit = cache().get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rate;
  try {
    const row = await getRate(key);
    const rate = row ? { unitKind: row.unitKind as RateUnitKind, amount: row.amount } : null;
    cache().set(key, { at: Date.now(), rate });
    return rate;
  } catch (err) {
    console.error(`[monedas] no se pudo leer la tarifa ${key}; se mide sin cobrar:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Unidades que cuesta un consumo según la tarifa `key`. 0 si no hay tarifa, es 0 o `CREDITS` está apagada. */
export async function priceFor(key: string, q: { tokens?: number; quantity?: number } = {}): Promise<number> {
  if (!creditsEnabled()) return 0;
  const rate = await rateOf(key);
  return rate ? priceUsage(rate, q) : 0;
}
