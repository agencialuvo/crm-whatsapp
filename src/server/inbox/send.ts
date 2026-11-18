import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { graphRequest, MetaApiError, normalizeRecipient } from "@/lib/meta/client";
import { destinatarioMeta, type Destinatario } from "@/lib/meta/destinatario";
import {
  getCredentialsByOrg,
  markReconnectRequired,
  type Credentials,
} from "@/server/whatsapp/credentials";
import { isWindowOpen, replyWindow } from "@/server/inbox/window";
import { plainSocialText } from "@/lib/social-text";
import { IG_PREFIX } from "@/server/inbox/identity";
import {
  getInstagramCredentialsByOrg,
  markInstagramReconnectRequired,
  type InstagramCredentials,
} from "@/server/instagram/credentials";
import { sendInstagramText } from "@/server/instagram/send";
import { FB_PREFIX } from "@/server/inbox/identity";
import {
  getMessengerCredentialsByOrg,
  markMessengerReconnectRequired,
  type MessengerCredentials,
} from "@/server/messenger/credentials";
import { sendMessengerText } from "@/server/messenger/send";
import { TT_PREFIX } from "@/server/inbox/identity";
import {
  getTiktokCredentialsByOrg,
  markTiktokReconnectRequired,
  type TiktokCredentials,
} from "@/server/tiktok/credentials";
import { sendTiktokText } from "@/server/tiktok/send";
import {
  cabeOtroMensaje,
  salientesDesdeElUltimoEntrante,
} from "@/server/inbox/outbound-cap";
import {
  capabilitiesFor,
  outboundLimitMessage,
  textFits,
  textLimitMessage,
  windowClosedMessage,
  windowMsFor,
  aiWindowClosedMessage,
} from "@/server/channels/capabilities";
import { isChannelEnabled } from "@/server/channels/enabled";
import { SendError } from "@/server/inbox/send-error";
import { isStaleMediaError, StaleMediaRetry, withStaleMediaRetry } from "@/lib/media-cache";
import { invalidateWaMediaId, MediaArchivoAusente, resolveWaMediaId } from "@/server/whatsapp/media-cache";
import { enviarYRegistrar } from "@/server/inbox/outbox";
import {
  saveMediaFile,
  uploadGraphMedia,
  validateOutgoing,
} from "@/server/whatsapp/media";

// 041: la clase vive en `send-error.ts` para que `outbox.ts` la use sin importar este archivo.
export { SendError };

type SendResult = { messageId: string };

type SendTarget = {
  conversation: typeof schema.conversation.$inferSelect;
  /** null cuando el destino no es WhatsApp (014). */
  credentials: Credentials | null;
  /** El destinatario en la forma que Meta espera: `to` o `recipient`. */
  destinatario: Destinatario;
  /** El identificador a secas, para lo que no arma un payload de Graph. */
  recipient: string;
  /** 014: presente solo en conversaciones de Instagram. */
  instagram?: InstagramCredentials;
  /** 017: presente solo en conversaciones de Messenger. */
  messenger?: MessengerCredentials;
  /** 022: presente solo en conversaciones de TikTok. */
  tiktok?: TiktokCredentials;
  /**
   * 024: el envío sale con la etiqueta de agente humano. Lo decide el
   * pre-vuelo (`assertReplyWindow`), no cada canal por su cuenta.
   */
  humanAgentTag?: boolean;
};

/**
 * 024 — La puerta de la ventana para los canales con extensión humana
 * (Instagram y Messenger). Devuelve si el envío lleva la etiqueta.
 *
 * - Dentro de la ventana normal escribe cualquiera.
 * - Después, y hasta el tope de la extensión, solo una persona, con la
 *   etiqueta. La IA no: Meta reserva esa etiqueta a agentes humanos.
 * - Pasado el tope (o sin ningún mensaje del cliente) no escribe nadie, y se
 *   dice aquí en vez de dejar que la plataforma rechace el envío con un error
 *   que el operador no entiende.
 */
function assertReplyWindow(
  conversation: SendTarget["conversation"],
  aiGenerated: boolean
): boolean {
  const w = replyWindow(conversation.channel, conversation.lastInboundAt);
  if (!w.operatorOpen) {
    throw new SendError("window_closed", windowClosedMessage(conversation.channel));
  }
  if (aiGenerated && !w.standardOpen) {
    throw new SendError("window_closed", aiWindowClosedMessage(conversation.channel));
  }
  return w.humanAgentTag;
}

/**
 * Pre-flight común de todo envío por la conversación (008): existencia +
 * tenant, sandbox del Laboratorio (ASERCIÓN DURA, FR-031: jamás toca la API
 * real), ventana de 24 h, credenciales y destinatario.
 */
async function prepareSend(
  conversationId: string,
  organizationId: string,
  /** 024: quién escribe decide si puede usar la extensión humana. */
  aiGenerated: boolean = false
): Promise<SendTarget> {
  const db = getDb();
  const rows = await db
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
    })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .where(eq(schema.conversation.id, conversationId))
    .limit(1);
  const row = rows[0];
  if (!row || row.conversation.organizationId !== organizationId) {
    throw new SendError("meta_error", "Conversación no encontrada");
  }

  if (row.conversation.isTest) {
    throw new SendError(
      "sandbox_violation",
      "Conversación de prueba del Laboratorio: el envío real está prohibido"
    );
  }

  // 014: Instagram tiene su propio transporte, su propia ventana y NO tiene
  // plantillas. Se resuelve antes que las credenciales de WhatsApp para no
  // exigirle a una instancia de solo-Instagram un numero conectado.
  if (row.conversation.channel === "instagram") {
    // Una conversacion de un canal apagado puede existir (se apago despues de
    // recibirla): falla claro en vez de intentar un transporte que no aplica.
    if (!isChannelEnabled("instagram")) {
      throw new SendError(
        "not_connected",
        "El canal de Instagram está desactivado en esta instancia"
      );
    }
    const igCreds = await getInstagramCredentialsByOrg(organizationId);
    if (!igCreds) {
      throw new SendError(
        "not_connected",
        "No hay cuenta de Instagram conectada"
      );
    }
    if (igCreds.status === "reconnect_required") {
      throw new SendError(
        "reconnect_required",
        "El token de Instagram expiró: reconecta la cuenta en Configuración"
      );
    }
    const igRecipient = row.contact.waIdentity.startsWith(IG_PREFIX)
      ? row.contact.waIdentity.slice(IG_PREFIX.length)
      : row.contact.waIdentity;
    const humanAgentTag = assertReplyWindow(row.conversation, aiGenerated);
    return {
      humanAgentTag,
      conversation: row.conversation,
      credentials: null,
      // Instagram no pasa por la Graph API de WhatsApp; el campo existe para
      // cumplir el tipo y su camino de envío no lo mira.
      destinatario: { to: igRecipient },
      recipient: igRecipient,
      instagram: igCreds,
    };
  }

  // 017: Messenger, mismo trato que Instagram: transporte propio, ventana
  // propia (con etiqueta fuera de ella) y sin plantillas.
  if (row.conversation.channel === "messenger") {
    if (!isChannelEnabled("messenger")) {
      throw new SendError(
        "not_connected",
        "El canal de Messenger está desactivado en esta instancia"
      );
    }
    const fbCreds = await getMessengerCredentialsByOrg(organizationId);
    if (!fbCreds) {
      throw new SendError(
        "not_connected",
        "No hay página de Facebook conectada"
      );
    }
    if (fbCreds.status === "reconnect_required") {
      throw new SendError(
        "reconnect_required",
        "El token de la página expiró: reconecta Messenger en Configuración"
      );
    }
    const fbRecipient = row.contact.waIdentity.startsWith(FB_PREFIX)
      ? row.contact.waIdentity.slice(FB_PREFIX.length)
      : row.contact.waIdentity;
    const humanAgentTag = assertReplyWindow(row.conversation, aiGenerated);
    return {
      humanAgentTag,
      conversation: row.conversation,
      credentials: null,
      // Messenger tampoco pasa por la Graph API de WhatsApp.
      destinatario: { to: fbRecipient },
      recipient: fbRecipient,
      messenger: fbCreds,
    };
  }

  // 022: TikTok. Transporte propio (Zernio) y los dos límites que ningún otro
  // canal tiene: la ventana no se puede reabrir, y admite un número contado de
  // mensajes desde el último entrante. Los dos se preguntan a las capacidades
  // y se comprueban AQUÍ, antes de llamar a nadie: el envío que la plataforma
  // rechazaría no sale, y falla con un motivo que el operador entiende.
  if (row.conversation.channel === "tiktok") {
    if (!isChannelEnabled("tiktok")) {
      throw new SendError(
        "not_connected",
        "El canal de TikTok está desactivado en esta instancia"
      );
    }
    const ttCreds = await getTiktokCredentialsByOrg(organizationId);
    if (!ttCreds) {
      throw new SendError("not_connected", "No hay cuenta de TikTok conectada");
    }
    if (ttCreds.status === "reconnect_required") {
      throw new SendError(
        "reconnect_required",
        "La llave de Zernio dejó de servir: reconecta TikTok en Configuración"
      );
    }
    if (
      !isWindowOpen(
        row.conversation.lastInboundAt,
        new Date(),
        windowMsFor("tiktok")
      )
    ) {
      throw new SendError("window_closed", windowClosedMessage("tiktok"));
    }
    const enviados = await salientesDesdeElUltimoEntrante(
      organizationId,
      conversationId
    );
    if (!cabeOtroMensaje("tiktok", enviados)) {
      throw new SendError("message_limit", outboundLimitMessage("tiktok"));
    }
    const ttRecipient = row.contact.waIdentity.startsWith(TT_PREFIX)
      ? row.contact.waIdentity.slice(TT_PREFIX.length)
      : row.contact.waIdentity;
    return {
      conversation: row.conversation,
      credentials: null,
      // TikTok tampoco pasa por la Graph API de WhatsApp.
      destinatario: { to: ttRecipient },
      recipient: ttRecipient,
      tiktok: ttCreds,
    };
  }

  // El nucleo no decide la politica: la consulta. WhatsApp exige plantilla
  // fuera de ventana; Instagram etiqueta y sigue; otro canal podria no tener
  // ventana en absoluto.
  const caps = capabilitiesFor(row.conversation.channel);
  if (
    caps.windowMs !== null &&
    caps.outsideWindow === "template" &&
    !isWindowOpen(row.conversation.lastInboundAt)
  ) {
    throw new SendError(
      "window_closed",
      windowClosedMessage(row.conversation.channel)
    );
  }

  const credentials = await getCredentialsByOrg(organizationId);
  if (!credentials) {
    throw new SendError("not_connected", "No hay número de WhatsApp conectado");
  }
  if (credentials.status === "reconnect_required") {
    throw new SendError(
      "reconnect_required",
      "El token de WhatsApp expiró: reconecta el número en Configuración"
    );
  }

  /**
   * 003 — El destinatario, en el campo que Meta espera para cada forma.
   *
   * Un teléfono va en `to`; un BSUID va en `recipient` con
   * `recipient_type: "individual"`. Se mandaba el BSUID en `to` y Meta
   * respondía 131026, que en la bandeja se lee como si el número del cliente
   * no existiera.
   */
  const destinatario = destinatarioMeta(
    row.contact.phone ? normalizeRecipient(row.contact.phone) : null,
    row.contact.waUserId
  );
  const recipient = destinatario
    ? "to" in destinatario
      ? destinatario.to
      : destinatario.recipient
    : null;
  if (!destinatario || !recipient) {
    throw new SendError(
      "meta_error",
      "El contacto no tiene teléfono ni identidad de WhatsApp utilizable"
    );
  }

  return { conversation: row.conversation, credentials, destinatario, recipient };
}

/**
 * 041 — Los envíos de la bandeja pasan TODOS por `enviarYRegistrar` (`outbox.ts`): la fila del
 * mensaje se inserta antes de llamar al canal y se confirma o se marca `failed` después.
 * Aquí solo queda lo propio de cada tipo: qué se manda y cómo se traducen sus errores.
 */

/** Envía un mensaje de texto libre por el canal de la conversación. */
export async function sendText(input: {
  conversationId: string;
  organizationId: string;
  text: string;
  aiGenerated?: boolean;
  /** 044 — Lo manda un flujo de automatización (no cuenta como primera respuesta). */
  automatico?: boolean;
}): Promise<SendResult> {
  const target = await prepareSend(
    input.conversationId,
    input.organizationId,
    input.aiGenerated ?? false
  );
  const { credentials } = target;
  const canal = target.conversation.channel;

  // 024: la IA escribe con formato de WhatsApp (y a veces Markdown). En un
  // canal que no lo dibuja se le quitan las marcas ANTES de medir, enviar y
  // guardar: lo que queda en el hilo es lo que el cliente leyó. Lo que escribe
  // una persona no se toca.
  const text =
    input.aiGenerated && capabilitiesFor(canal).textFormat === "plain"
      ? plainSocialText(input.text)
      : input.text;

  // 022: el límite de longitud es del canal. WhatsApp y TikTok lo declaran en
  // caracteres y se comprueba aquí, antes de llamar a nadie; Instagram y
  // Messenger (en bytes) lo siguen comprobando en su propio camino.
  if (capabilitiesFor(canal).maxTextChars !== null && !textFits(canal, text)) {
    throw new SendError("text_too_long", textLimitMessage(canal));
  }

  const { messageId } = await enviarYRegistrar({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    automatico: input.automatico,
    fila: {
      type: "text",
      text,
      origin: input.aiGenerated ? "ai" : "operator",
      aiGenerated: input.aiGenerated,
    },
    // Un canal sin acuses de entrega confirma al aceptar; uno con acuses
    // avanza despues por webhook. Sin esta distincion el mensaje se queda
    // con el reloj puesto para siempre.
    estadoAlAceptar: capabilitiesFor(canal).deliveryReceipts ? "pending" : "sent",
    enviar: () =>
      target.instagram
        ? callInstagramSend(target, text)
        : target.messenger
          ? callMessengerSend(target, text)
          : target.tiktok
            ? callTiktokSend(target, text)
            : callGraphSend(credentials!, {
                messaging_product: "whatsapp",
                ...target.destinatario,
                type: "text",
                text: { body: text },
              }),
  });
  return { messageId };
}

/**
 * 008 — Envía un adjunto de archivo (imagen/video/audio/documento).
 * El archivo queda ANTES en el volumen local (fuente durable de la preview);
 * si el envío falla tras eso, el mensaje queda `failed` (visible en el hilo,
 * nunca se pierde en silencio) y el SendError lleva `messageId`.
 */
export async function sendMediaMessage(input: {
  conversationId: string;
  organizationId: string;
  file: { data: Buffer; mimeType: string; fileName?: string };
  caption?: string;
  automatico?: boolean;
}): Promise<SendResult> {
  // Validación previa (FR-007): tipo y tamaño antes de tocar disco o red.
  const kind = validateOutgoing(input.file.mimeType, input.file.data.byteLength);

  const target = await prepareSend(input.conversationId, input.organizationId);
  const { credentials } = target;
  const sendCaps = capabilitiesFor(target.conversation.channel);
  if (!sendCaps.outboundMedia) {
    throw new SendError(
      "meta_error",
      `Todavía no se pueden enviar adjuntos por ${sendCaps.label}; manda el texto`
    );
  }

  const db = getDb();
  const assetId = newId("mediaAsset");
  const storagePath = await saveMediaFile(
    input.organizationId,
    assetId,
    input.file.data
  );
  const assetRows = await db
    .insert(schema.mediaAsset)
    .values({
      id: assetId,
      organizationId: input.organizationId,
      kind,
      mimeType: input.file.mimeType,
      fileName: input.file.fileName ?? null,
      fileSize: input.file.data.byteLength,
      caption: input.caption ?? null,
      storagePath,
      fetchStatus: "available",
    })
    .returning();
  const asset = assetRows[0]!;

  const { messageId } = await enviarYRegistrar({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    automatico: input.automatico,
    fila: {
      type: kind,
      text: null,
      origin: "operator",
      mediaAssetId: assetId,
      media: asset,
    },
    estadoAlAceptar: "pending",
    enviar: async () => {
      try {
        const waMediaId = await uploadGraphMedia(credentials!, input.file);
        await db
          .update(schema.mediaAsset)
          .set({ waMediaId, updatedAt: new Date() })
          .where(eq(schema.mediaAsset.id, assetId));

        const mediaPayload: Record<string, unknown> = { id: waMediaId };
        if (input.caption && kind !== "audio") mediaPayload.caption = input.caption;
        if (kind === "document" && input.file.fileName) {
          mediaPayload.filename = input.file.fileName;
        }
        return await callGraphSend(credentials!, {
          messaging_product: "whatsapp",
          ...target.destinatario,
          type: kind,
          [kind]: mediaPayload,
        });
      } catch (err) {
        if (err instanceof SendError) throw err;
        if (err instanceof MetaApiError && err.isAuthError) {
          // Mismo criterio que el texto: SOLO 401/código 190 (fix 2026-08-04).
          await markReconnectRequired(input.organizationId);
          throw new SendError(
            "reconnect_required",
            "El token de WhatsApp expiró: reconecta el número en Configuración"
          );
        }
        throw new SendError("upload_failed", "No se pudo subir el adjunto a WhatsApp");
      }
    },
  });
  return { messageId };
}

/**
 * 048 — Envía un medio de la BIBLIOTECA por su `media_id` de WhatsApp, sin copiar el archivo: la fila del adjunto
 * (`media_asset`) solo apunta al medio (`library_item_id`), así un envío repetido no deja una copia en disco por mensaje.
 *
 * El `media_id` sale de la caché por número (`resolveWaMediaId`): vigente → se manda `{ id }` sin tocar el archivo ni la
 * red de subida; vencido o ausente → se sube UNA vez y se guarda 25 días. Si Meta rechaza un id que veníamos
 * reutilizando por «media vencido o inválido», se olvida, se sube de nuevo y se reintenta UNA sola vez (nunca un bucle).
 */
export async function sendLibraryMedia(input: {
  conversationId: string;
  organizationId: string;
  mediaId: string;
  caption?: string;
  automatico?: boolean;
}): Promise<SendResult> {
  const db = getDb();
  const m = schema.mediaLibraryItem;
  const [item] = await db
    .select()
    .from(m)
    .where(and(eq(m.organizationId, input.organizationId), eq(m.id, input.mediaId), eq(m.status, "ready")))
    .limit(1);
  if (!item) throw new SendError("meta_error", "El archivo ya no está en la biblioteca de Medios");
  // Tipo y peso contra los límites de la Cloud API (antes de tocar red).
  const kind = validateOutgoing(item.mimeType, item.sizeBytes);

  const target = await prepareSend(input.conversationId, input.organizationId);
  const { credentials } = target;
  const sendCaps = capabilitiesFor(target.conversation.channel);
  if (!sendCaps.outboundMedia) {
    throw new SendError("meta_error", `Todavía no se pueden enviar adjuntos por ${sendCaps.label}; manda el texto`);
  }

  const ext = item.mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "";
  const fileName = ext ? `${item.name}.${ext}` : item.name;
  const assetRows = await db
    .insert(schema.mediaAsset)
    .values({
      id: newId("mediaAsset"),
      organizationId: input.organizationId,
      kind,
      mimeType: item.mimeType,
      fileName,
      fileSize: item.sizeBytes,
      caption: input.caption ?? null,
      storagePath: null,
      libraryItemId: item.id,
      fetchStatus: "available",
    })
    .returning();
  const asset = assetRows[0]!;

  const { messageId } = await enviarYRegistrar({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    automatico: input.automatico,
    fila: { type: kind, text: null, origin: "operator", mediaAssetId: asset.id, media: asset },
    estadoAlAceptar: "pending",
    enviar: async () => {
      const mandar = async (forceRefresh: boolean) => {
        const r = await resolveWaMediaId(item, credentials!, { forceRefresh });
        await db.update(schema.mediaAsset).set({ waMediaId: r.waMediaId, updatedAt: new Date() }).where(eq(schema.mediaAsset.id, asset.id));
        const mediaPayload: Record<string, unknown> = { id: r.waMediaId };
        if (input.caption && kind !== "audio") mediaPayload.caption = input.caption;
        if (kind === "document") mediaPayload.filename = fileName;
        try {
          return await callGraphSend(credentials!, {
            messaging_product: "whatsapp",
            ...target.destinatario,
            type: kind,
            [kind]: mediaPayload,
          });
        } catch (err) {
          // Un id que veníamos reutilizando y Meta ya no reconoce: se invalida y el llamador reintenta una vez.
          const rechazo = err instanceof SendError ? err.metaError : undefined;
          if (!forceRefresh && r.reused && err instanceof SendError && err.code === "meta_error" && isStaleMediaError({ code: rechazo?.code, details: rechazo?.details, message: err.message })) {
            await invalidateWaMediaId(item, credentials!.phoneNumberId).catch(() => {});
            throw new StaleMediaRetry();
          }
          throw err;
        }
      };
      try {
        return await withStaleMediaRetry(mandar);
      } catch (err) {
        if (err instanceof SendError) throw err;
        if (err instanceof MediaArchivoAusente) {
          throw new SendError("upload_failed", "El archivo ya no está en el almacenamiento de Medios");
        }
        if (err instanceof MetaApiError && err.isAuthError) {
          await markReconnectRequired(input.organizationId);
          throw new SendError("reconnect_required", "El token de WhatsApp expiró: reconecta el número en Configuración");
        }
        throw new SendError("upload_failed", "No se pudo subir el adjunto a WhatsApp");
      }
    },
  });
  return { messageId };
}

export type LocationInput = {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
};

export type ContactInput = { name: string; phone: string };

/** 008 — Envía una ubicación o contactos (payload estructurado, sin archivo). */
export async function sendStructured(
  input: {
    conversationId: string;
    organizationId: string;
  } & (
    | { kind: "location"; location: LocationInput }
    | { kind: "contacts"; contacts: ContactInput[] }
  )
): Promise<SendResult> {
  const target = await prepareSend(
    input.conversationId,
    input.organizationId
  );
  // Ubicaciones y contactos son mensajes de WhatsApp: en los demás canales no
  // hay credenciales de WhatsApp que usar y Graph los rechazaría.
  if (!target.credentials) {
    throw new SendError(
      "meta_error",
      "Este canal no admite ubicaciones ni contactos; manda el texto"
    );
  }
  const credentials = target.credentials;

  const payload =
    input.kind === "location"
      ? { type: "location", location: input.location }
      : {
          type: "contacts",
          contacts: input.contacts.map((c) => ({
            name: { formatted_name: c.name, first_name: c.name },
            phones: [{ phone: c.phone, type: "CELL" }],
          })),
        };

  // 041: el contenido se guarda ANTES de llamar a Graph, igual que el adjunto de
  // archivo, para que la burbuja fallida también muestre qué se quiso mandar.
  const db = getDb();
  const assetRows = await db
    .insert(schema.mediaAsset)
    .values({
      id: newId("mediaAsset"),
      organizationId: input.organizationId,
      kind: input.kind,
      payload: input.kind === "location" ? input.location : input.contacts,
      fetchStatus: "available",
    })
    .returning();
  const asset = assetRows[0]!;

  const { messageId } = await enviarYRegistrar({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    fila: {
      type: input.kind,
      text: null,
      origin: "operator",
      mediaAssetId: asset.id,
      media: asset,
    },
    estadoAlAceptar: "pending",
    enviar: () =>
      callGraphSend(credentials, {
        messaging_product: "whatsapp",
        ...target.destinatario,
        ...payload,
      }),
  });
  return { messageId };
}

/** Llama a Graph /messages y traduce errores de Meta a SendError. */
export async function callGraphSend(
  credentials: Credentials,
  payload: unknown
): Promise<string> {
  try {
    const res = await graphRequest<{ messages?: { id: string }[] }>(
      `${credentials.phoneNumberId}/messages`,
      { method: "POST", token: credentials.token, body: payload }
    );
    const id = res.messages?.[0]?.id;
    if (!id) throw new SendError("meta_error", "Meta no devolvió ID de mensaje");
    return id;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markReconnectRequired(credentials.organizationId);
        throw new SendError(
          "reconnect_required",
          "El token de WhatsApp expiró: reconecta el número en Configuración"
        );
      }
      if (err.status === 0 || err.status >= 500) {
        // 041: un tiempo agotado es ambiguo (pudo haber salido) y su texto lo dice.
        throw new SendError(
          "meta_unavailable",
          err.ambiguous ? err.message : "Meta no está disponible ahora"
        );
      }
      throw Object.assign(new SendError("meta_error", err.message), { metaError: { code: err.code, details: err.details } });
    }
    throw err;
  }
}


/**
 * 014 — Envío por el canal de Instagram. Traduce los fallos al mismo
 * vocabulario de SendError que ya usa WhatsApp, para que la bandeja no tenga
 * que aprender un idioma por plataforma.
 */
async function callInstagramSend(
  target: SendTarget,
  text: string
): Promise<string> {
  const creds = target.instagram!;

  const caps = capabilitiesFor("instagram");
  if (!textFits("instagram", text)) {
    throw new SendError(
      "meta_error",
      `${caps.label} no acepta mensajes de más de ${caps.maxTextBytes} bytes: acorta el texto`
    );
  }

  // Instagram no tiene plantillas: fuera de la ventana de 24 h la única vía
  // es la etiqueta de agente humano (hasta 7 días). 024: quién puede usarla
  // lo decidió ya el pre-vuelo.
  const humanAgentTag = target.humanAgentTag ?? false;

  try {
    const res = await sendInstagramText({
      credentials: creds,
      recipient: target.recipient,
      threadRef: target.conversation.channelThreadRef,
      text,
      humanAgentTag,
    });
    return res.platformMessageId;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markInstagramReconnectRequired(creds.organizationId);
        throw new SendError(
          "reconnect_required",
          "El token de Instagram expiró o fue revocado: reconecta la cuenta"
        );
      }
      if (err.status === 0 || err.status >= 500) {
        throw new SendError(
          "meta_unavailable",
          err.ambiguous ? err.message : "Instagram no está disponible en este momento; intenta de nuevo"
        );
      }
      throw new SendError("meta_error", err.message);
    }
    throw err;
  }
}

/**
 * 017 — Envío por el canal de Messenger. Mismo vocabulario de SendError que
 * WhatsApp e Instagram: la bandeja no aprende un idioma por plataforma.
 */
async function callMessengerSend(
  target: SendTarget,
  text: string
): Promise<string> {
  const creds = target.messenger!;

  const caps = capabilitiesFor("messenger");
  if (!textFits("messenger", text)) {
    throw new SendError(
      "meta_error",
      `${caps.label} no acepta mensajes de más de ${caps.maxTextBytes} bytes: acorta el texto`
    );
  }

  // Messenger no tiene plantillas: fuera de la ventana de 24 h la única vía
  // es la etiqueta de agente humano (hasta 7 días). 024: quién puede usarla
  // lo decidió ya el pre-vuelo.
  const humanAgentTag = target.humanAgentTag ?? false;

  try {
    const res = await sendMessengerText({
      credentials: creds,
      recipient: target.recipient,
      // Zernio responde dentro de SU conversación, no al PSID: sin esta
      // referencia el envío no tiene a dónde ir.
      threadRef: target.conversation.channelThreadRef,
      text,
      humanAgentTag,
    });
    return res.platformMessageId;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markMessengerReconnectRequired(creds.organizationId);
        throw new SendError(
          "reconnect_required",
          "El token de la página expiró o fue revocado: reconecta Messenger"
        );
      }
      if (err.status === 0 || err.status >= 500) {
        throw new SendError(
          "meta_unavailable",
          err.ambiguous ? err.message : "Messenger no está disponible en este momento; intenta de nuevo"
        );
      }
      throw new SendError("meta_error", err.message);
    }
    throw err;
  }
}

/**
 * 022 — Envío por el canal de TikTok. Mismo vocabulario de SendError que los
 * demás canales. La ventana y el tope ya se comprobaron en `prepareSend`.
 */
async function callTiktokSend(target: SendTarget, text: string): Promise<string> {
  const creds = target.tiktok!;

  try {
    const res = await sendTiktokText({
      credentials: creds,
      // Zernio responde dentro de SU conversación: sin esta referencia el
      // envío no tiene a dónde ir.
      threadRef: target.conversation.channelThreadRef,
      text,
    });
    return res.platformMessageId;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markTiktokReconnectRequired(creds.organizationId);
        throw new SendError(
          "reconnect_required",
          "La llave de Zernio expiró o fue revocada: reconecta TikTok"
        );
      }
      if (err.status === 0 || err.status >= 500) {
        throw new SendError(
          "meta_unavailable",
          err.ambiguous ? err.message : "TikTok no está disponible en este momento; intenta de nuevo"
        );
      }
      throw new SendError("meta_error", err.message);
    }
    throw err;
  }
}
