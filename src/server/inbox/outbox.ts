import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { MetaApiError } from "@/lib/meta/client";
import { publish } from "@/server/events/bus";
import { serializeMessage } from "@/server/inbox/ingest";
import { SendError } from "@/server/inbox/send-error";
import { reclaimOrphanStatus } from "@/server/inbox/status";
import { avanzarPorRespuesta } from "@/server/leads/auto-stage";
import { medirEnvio, type ConsumoEnvio } from "@/server/inbox/metering";

/**
 * 041 — El registro de todo lo que sale por la bandeja.
 *
 * La regla: **la fila del mensaje existe ANTES de llamar a nadie.** Se inserta en `pending`
 * (sin `wa_message_id`), se llama al transporte, y la fila se confirma (`wa_message_id`, y
 * `sent` en los canales sin acuses) o se marca `failed` con el motivo. Así un envío no
 * puede salir sin quedar registrado, y un fallo se ve igual para texto, plantilla,
 * ubicación, contacto y adjunto.
 *
 * Lo que NO cierra esto solo es la carrera con el webhook de estado (llega antes de que el
 * id esté guardado): la cubre el búfer de `status.ts`, que `confirmarEnvio` consulta al
 * guardar el id.
 */

type MediaAsset = typeof schema.mediaAsset.$inferSelect;

export type FilaSaliente = {
  type: string;
  text: string | null;
  origin: "ai" | "operator" | "template";
  aiGenerated?: boolean;
  mediaAssetId?: string | null;
  media?: MediaAsset | null;
};

export type FilaRegistrada = {
  id: string;
  organizationId: string;
  conversationId: string;
};

/** Inserta la intención de envío y avisa a la bandeja. Un rechazo del pre-vuelo NO llega aquí. */
export async function registrarIntento(
  organizationId: string,
  conversationId: string,
  fila: FilaSaliente
): Promise<FilaRegistrada> {
  const db = getDb();
  const message = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.message)
      .values({
        id: newId("message"),
        organizationId,
        conversationId,
        waMessageId: null,
        direction: "out",
        type: fila.type,
        text: fila.text,
        status: "pending",
        aiGenerated: fila.aiGenerated ?? false,
        origin: fila.origin,
        mediaAssetId: fila.mediaAssetId ?? null,
      })
      .returning();
    await tx
      .update(schema.conversation)
      .set({ lastMessageAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.conversation.id, conversationId));
    return inserted!;
  });

  publish(organizationId, {
    type: "message.new",
    data: { conversationId, message: serializeMessage(message, fila.media ?? null) },
  });
  return { id: message.id, organizationId, conversationId };
}

/** Marca el intento como fallido, con el motivo ya traducido. No degrada un mensaje que ya avanzó. */
export async function registrarFallo(fila: FilaRegistrada, motivo: string): Promise<void> {
  const updated = await getDb()
    .update(schema.message)
    .set({ status: "failed", error: motivo })
    .where(and(eq(schema.message.id, fila.id), eq(schema.message.status, "pending")))
    .returning({ id: schema.message.id });
  if (!updated[0]) return;
  publish(fila.organizationId, {
    type: "message.status",
    data: {
      conversationId: fila.conversationId,
      messageId: fila.id,
      status: "failed",
      error: motivo,
    },
  });
}

const ESPERAS_MS = [0, 150, 600];

export type OpcionesConfirmar = {
  /** Las esperas entre intentos; la longitud es el número de intentos. */
  esperas?: number[];
  /** Cómo se guarda el id (las pruebas lo sustituyen para simular un fallo de la base). */
  guardarId?: (
    fila: FilaRegistrada,
    waMessageId: string,
    estado: "pending" | "sent"
  ) => Promise<boolean>;
};

async function guardarIdEnBase(
  fila: FilaRegistrada,
  waMessageId: string,
  estado: "pending" | "sent"
): Promise<boolean> {
  const updated = await getDb()
    .update(schema.message)
    .set({ waMessageId, status: estado })
    .where(and(eq(schema.message.id, fila.id), sql`${schema.message.waMessageId} is null`))
    .returning({ id: schema.message.id });
  return updated.length > 0;
}

/**
 * Guarda el `wa_message_id` que devolvió la plataforma y recoge el estado que pudo llegar
 * antes. `estado` es `pending` donde los acuses llegan por webhook (WhatsApp) y `sent` donde
 * aceptar ES la confirmación (Instagram, Messenger, TikTok).
 *
 * Si la base falla se reintenta; si sigue fallando se deja constancia con el id de Meta y la
 * fila queda como un intento sin confirmar (la barredera la rescata). Jamás lanza: el
 * mensaje YA salió y quien llama no tiene nada que deshacer.
 */
export async function confirmarEnvio(
  fila: FilaRegistrada,
  waMessageId: string,
  estado: "pending" | "sent",
  opts: OpcionesConfirmar = {}
): Promise<boolean> {
  const esperas = opts.esperas ?? ESPERAS_MS;
  const guardar = opts.guardarId ?? guardarIdEnBase;
  let ultimo: unknown = null;
  for (const espera of esperas) {
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    try {
      await guardar(fila, waMessageId, estado);
      if (estado === "sent") {
        publish(fila.organizationId, {
          type: "message.status",
          data: {
            conversationId: fila.conversationId,
            messageId: fila.id,
            status: "sent",
            error: null,
          },
        });
      } else {
        await reclaimOrphanStatus(fila.organizationId, waMessageId);
      }
      return true;
    } catch (err) {
      ultimo = err;
    }
  }
  console.error(
    `[envio] Meta aceptó el mensaje ${waMessageId} pero no se pudo guardar en ${fila.conversationId} (${fila.id}):`,
    ultimo
  );
  return false;
}

/** El motivo que se muestra en la burbuja `failed`, sin filtrar detalles internos. */
function motivoDe(err: unknown): string {
  if (err instanceof SendError) return err.message;
  if (err instanceof MetaApiError) return err.message;
  return "Error interno al enviar el mensaje";
}

/**
 * El camino único de todo envío: intención → transporte → confirmación o fallo.
 *
 * `enviar` devuelve el id de la plataforma. Debe lanzar `SendError` para lo que sabe
 * explicar; cualquier otra excepción deja la fila `failed` con un motivo genérico y se
 * relanza sin tocar (es un fallo de programación, no de la plataforma).
 */
export async function enviarYRegistrar(input: {
  organizationId: string;
  conversationId: string;
  fila: FilaSaliente;
  estadoAlAceptar: "pending" | "sent";
  enviar: () => Promise<string>;
  confirmar?: OpcionesConfirmar;
  /** 044 — Lo envía un flujo de automatización: NO cuenta como «primera respuesta» del operador/IA. */
  automatico?: boolean;
  /** Monedas: qué se mide (y, si es una plantilla de WhatsApp, se cobra) cuando Meta acepta el mensaje. */
  consumo?: ConsumoEnvio;
}): Promise<{ messageId: string; waMessageId: string }> {
  const registrada = await registrarIntento(
    input.organizationId,
    input.conversationId,
    input.fila
  );
  let waMessageId: string;
  try {
    waMessageId = await input.enviar();
  } catch (err) {
    await registrarFallo(registrada, motivoDe(err)).catch((e) =>
      console.error(`[envio] no se pudo marcar fallido ${registrada.id}:`, e)
    );
    if (err instanceof SendError) err.messageId = registrada.id;
    throw err;
  }
  await confirmarEnvio(registrada, waMessageId, input.estadoAlAceptar, input.confirmar);
  // Monedas: con el id de Meta en mano el envío es un hecho. No lanza, y apagadas no toca la base.
  if (input.consumo) {
    await medirEnvio({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      messageId: registrada.id,
      waMessageId,
      consumo: input.consumo,
    });
  }
  // 044: la primera respuesta humana o de la IA avanza el lead de «Nuevo» a «En conversación». Tras el
  // envío confirmado y sin poder fallar hacia arriba (el mensaje ya salió).
  if (!input.automatico) await avanzarPorRespuesta(input.organizationId, input.conversationId);
  return { messageId: registrada.id, waMessageId };
}

export const SIN_CONFIRMAR =
  "No se pudo confirmar el envío (el servidor se reinició o Meta no respondió). Posible envío incompleto: verifica en la conversación o en Meta antes de reenviar";

const UMBRAL_POR_OMISION_MS = 180_000;
const TANDA = 200;
const HUERFANOS_MAX_MS = 24 * 3_600_000;

/**
 * La barredera: rescata lo que ninguna respuesta va a cerrar.
 *
 * - Intentos `pending` sin `wa_message_id` de más de 3 minutos (el doble del tiempo máximo de
 *   una llamada a Graph) → `failed`: el proceso se reinició entre la intención y la respuesta.
 *   Las conversaciones de prueba no se tocan.
 * - Estados huérfanos de más de 24 h → fuera: eran de mensajes que nunca existieron aquí.
 *
 * Idempotente, por tandas y sin candados largos. `OUTBOX_SWEEP_AFTER_MS` existe solo para las
 * pruebas de extremo a extremo.
 */
export async function sweepOutbox(
  opts: { olderThanMs?: number } = {}
): Promise<{ rescued: number; purged: number }> {
  const db = getDb();
  const env = Number(process.env.OUTBOX_SWEEP_AFTER_MS);
  const umbral =
    opts.olderThanMs ?? (Number.isFinite(env) && env > 0 ? env : UMBRAL_POR_OMISION_MS);

  const rescued = await db.execute<{
    id: string;
    organization_id: string;
    conversation_id: string;
  }>(sql`
    update message set status = 'failed', error = ${SIN_CONFIRMAR}
    where id in (
      select m.id from message m
      join conversation c on c.id = m.conversation_id
      where m.direction = 'out'
        and m.status = 'pending'
        and m.wa_message_id is null
        and c.is_test = false
        and m.created_at < now() - (${umbral} * interval '1 millisecond')
      order by m.created_at
      limit ${TANDA}
      for update of m skip locked
    )
    returning id, organization_id, conversation_id
  `);
  for (const r of rescued) {
    publish(r.organization_id, {
      type: "message.status",
      data: {
        conversationId: r.conversation_id,
        messageId: r.id,
        status: "failed",
        error: SIN_CONFIRMAR,
      },
    });
  }

  const purged = await db.execute<{ id: string }>(sql`
    delete from message_status_orphan
    where received_at < now() - (${HUERFANOS_MAX_MS} * interval '1 millisecond')
    returning id
  `);
  return { rescued: rescued.length, purged: purged.length };
}
