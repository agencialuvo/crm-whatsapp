import { idemKey, RATE_KEYS, templateRateKey } from "@/lib/credits";
import { checkCredit, creditsEnabled, priceFor, recordUsage, spendCredits } from "@/server/credits";
import { ensureCreditAccount } from "@/server/saas/credits-sync";

/**
 * Monedas — los envíos. Solo se COBRA la plantilla de WhatsApp, por su categoría de Meta; el mensaje libre dentro de
 * la ventana de 24 h, los adjuntos, las ubicaciones y los demás canales se MIDEN con tarifa 0, y `typing` ni se
 * mide. El cobro va DESPUÉS de que Meta acepta el mensaje (id en mano) y es idempotente por `wa:<id del mensaje>`;
 * el corte va ANTES, en `sendTemplate`. Con `CREDITS` apagada todo es un no-op que no toca la base.
 */

export type ConsumoEnvio = {
  channel: string;
  template?: boolean;
  /** Solo plantillas de WhatsApp: su categoría de Meta (`marketing`, `utility`, `authentication`). */
  templateCategory?: string | null;
};

const TEXT = "text";

function categoryOf(c: ConsumoEnvio): string {
  if (!c.template) return TEXT;
  return (c.templateCategory ?? "").trim().toLowerCase() || "other";
}

/** Lo que cuesta este envío AHORA. 0 salvo plantillas de WhatsApp con tarifa. */
export async function precioDeEnvio(c: ConsumoEnvio): Promise<number> {
  if (!c.template || c.channel !== "whatsapp") return 0;
  return priceFor(templateRateKey(c.templateCategory));
}

/**
 * ¿Se puede mandar esta plantilla? Con el corte activo y sin saldo, `allow: false`. En modo sombra deja pasar y
 * `wouldCut` lo anota. No lanza: ante un fallo propio deja pasar (cortar por un error nuestro es peor).
 */
export async function puedeEnviar(
  organizationId: string,
  c: ConsumoEnvio
): Promise<{ allow: boolean; wouldCut: boolean; price: number }> {
  if (!creditsEnabled()) return { allow: true, wouldCut: false, price: 0 };
  try {
    const price = await precioDeEnvio(c);
    if (price <= 0) return { allow: true, wouldCut: false, price };
    await ensureCreditAccount(organizationId);
    const gate = await checkCredit(organizationId, { amount: price });
    return { allow: gate.allow, wouldCut: gate.wouldCut, price };
  } catch (err) {
    console.error("[monedas] pre-chequeo del envío:", err instanceof Error ? err.message : err);
    return { allow: true, wouldCut: false, price: 0 };
  }
}

/** Mide el envío y cobra lo que corresponda. Nunca lanza: el mensaje ya salió. */
export async function medirEnvio(input: {
  organizationId: string;
  conversationId: string;
  messageId: string;
  waMessageId: string;
  consumo: ConsumoEnvio;
}): Promise<void> {
  if (!creditsEnabled()) return;
  const { organizationId, messageId, consumo } = input;
  try {
    const price = await precioDeEnvio(consumo);
    let wouldCut = false;
    if (price > 0) {
      const gate = await checkCredit(organizationId, { amount: price });
      wouldCut = gate.wouldCut;
    }
    await recordUsage({
      organizationId,
      service: "whatsapp",
      category: categoryOf(consumo),
      quantity: 1,
      conversationId: input.conversationId,
      refType: "message",
      refId: messageId,
      chargedUnits: price,
      wouldCut,
      idempotencyKey: idemKey.waMessage(messageId),
      meta: {
        channel: consumo.channel,
        waMessageId: input.waMessageId,
        rate: consumo.template ? templateRateKey(consumo.templateCategory) : RATE_KEYS.waText,
      },
    });
    if (price > 0) {
      await spendCredits({
        organizationId,
        service: "whatsapp",
        amount: price,
        idempotencyKey: idemKey.waMessage(messageId),
        refType: "message",
        refId: messageId,
        meta: { category: categoryOf(consumo), waMessageId: input.waMessageId },
      });
    }
  } catch (err) {
    console.error(`[monedas] no se pudo medir el envío ${messageId}:`, err instanceof Error ? err.message : err);
  }
}
