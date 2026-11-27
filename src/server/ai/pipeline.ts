import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { getAttributionForConversation } from "@/server/attribution/store";
import { atribucionEnabled } from "@/server/attribution/flag";
import { bookingTargetOf } from "@/lib/ad-flow";
import { getAdFlowContext } from "@/server/ai/ad-flow-context";
import { scoped } from "@/lib/db/tenant";
import { moveLeadToStage as moveLeadThroughHistory } from "@/server/leads/stage-history";
import { getEnv } from "@/lib/env";
import { chatJson, type ChatMessage } from "@/lib/ai";
import { isAiConfiguredFor } from "@/lib/ai/provider";
import { publish } from "@/server/events/bus";
import { isWindowOpen } from "@/server/inbox/window";
import { textFits, windowMsFor } from "@/server/channels/capabilities";
import { SendError, sendText } from "@/server/inbox/send";
import {
  agentActionSchema,
  degradeAction,
  resolveStage,
  type AgentActionType,
} from "@/server/ai/actions";
import { HANDOFF_BACKUP_ACK, matchesHandoffIntent } from "@/server/ai/handoff";
import {
  buildAgentSystemPrompt,
  TURN_FORMAT_REMINDER,
} from "@/server/ai/prompts";
import {
  atendidoPorPersona,
  debidosVigentes,
  ordenarParaElTurno,
  quedanDebidos,
} from "@/server/ai/orden-turno";
import { agendaEnabled } from "@/server/agenda/flag";
import { bookSlot, offerSlots } from "@/server/agenda/agent";
import { bookableStaff } from "@/server/agenda/availability";
import { getOffers, mapaDeHuecosParaModelo } from "@/server/agenda/offers";
import { salonEnabled } from "@/server/business/flag";
import { getPlanAccess } from "@/server/business/saas-guard";
import { notifyHandoff } from "@/server/notifications/service";
import { getComboTriggerInstruction } from "@/server/ai/barbershop-context";
import { isConversationSilenced } from "@/server/ai/ignored";
import { beginAiTurnMeter } from "@/server/ai/metering";
import { loadTemporalContext } from "@/server/ai/turn-context";
import { appendAiNote } from "@/lib/agent/notes";
import { textoParaModelo } from "@/lib/agent/history";
import { partirParaCanal } from "@/lib/agent/split";
import { renderKbForPrompt } from "@/lib/kb-budget";
import { revalidarTurno } from "@/server/ai/turn-guard";
import { reforzarExclusivo } from "@/server/ai/exclusive-guard";

/**
 * Turno del agente (FR-021..FR-025).
 *
 * Coalesce + lock in-process por conversación: ráfagas de mensajes → UNA
 * respuesta; nunca dos turnos simultáneos; lo que llega durante un turno
 * re-encola exactamente un turno más. Suficiente para el monolito de una
 * instancia (sin colas externas — Constitución II).
 *
 * LIMITACIÓN CONOCIDA: el agrupado vive en memoria. Si el proceso se reinicia
 * durante la espera del debounce (`AGENT_COALESCE_MS`) o a mitad de un turno,
 * ese turno se pierde y el mensaje queda en la Bandeja sin respuesta de la IA
 * (no se reintenta al arrancar). Tampoco sirve con varias réplicas: cada una
 * tendría su propio mapa. Es una decisión de diseño del monolito, no un error.
 *
 * 025 — La entrada lleva además qué entrantes DEBE el siguiente turno. Lo que
 * el cliente escribe mientras el modelo piensa queda, por hora, antes de la
 * respuesta que sale de ese turno; sin esa cuenta el turno siguiente lee una
 * conversación que termina en su propia respuesta. Es la misma memoria que el
 * despacho guarda en `dispatch.message_ids`, aquí en proceso, como `pending`.
 */

type CoalesceEntry = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  pending: boolean;
  /** Entrantes anotados para el siguiente turno. */
  debidos: Set<string>;
};

const globalForAgent = globalThis as unknown as {
  __agentCoalesce?: Map<string, CoalesceEntry>;
};

function coalesceMap(): Map<string, CoalesceEntry> {
  if (!globalForAgent.__agentCoalesce) {
    globalForAgent.__agentCoalesce = new Map();
  }
  return globalForAgent.__agentCoalesce;
}

/**
 * Punto de entrada con debounce (mensajes entrantes reales). `messageId` es
 * el entrante que lo provoca.
 */
export function scheduleAgentTurn(
  conversationId: string,
  messageId: string
): void {
  const map = coalesceMap();
  const entry = map.get(conversationId) ?? {
    timer: null,
    running: false,
    pending: false,
    debidos: new Set<string>(),
  };
  map.set(conversationId, entry);
  entry.debidos.add(messageId);

  if (entry.running) {
    entry.pending = true; // se re-encola al terminar el turno actual
    return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  const delay = getEnv().AGENT_COALESCE_MS;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void executeTurn(conversationId);
  }, delay);
}

async function executeTurn(conversationId: string): Promise<void> {
  const map = coalesceMap();
  const entry = map.get(conversationId);
  if (!entry || entry.running) return;
  entry.running = true;
  // Lo anotado hasta aquí es de ESTE turno. Lo que entre desde ahora cae en
  // un conjunto nuevo: es lo que, al terminar, puede seguir debiéndose.
  const deEsteTurno = [...entry.debidos];
  entry.debidos = new Set();
  let leido: TurnoLeido | undefined;
  try {
    leido = await runAgentTurn(conversationId, { debidos: deEsteTurno });
  } catch (err) {
    console.error("[agente] turno falló:", err);
  } finally {
    entry.running = false;
    // Si el turno no llegó a leer (falló, o se calló antes de abrir el
    // historial), lo que traía se sigue debiendo.
    if (!leido) for (const id of deEsteTurno) entry.debidos.add(id);
    // Y si leyó, lo que entró mientras tanto y alcanzó a ver ya está
    // atendido: repetir el turno sería contestarle dos veces.
    const quedan = quedanDebidos(entry.debidos, leido?.vistos);
    entry.debidos = new Set(quedan);
    const repetir = entry.pending && quedan.length > 0;
    entry.pending = false;
    if (repetir) {
      void executeTurn(conversationId);
    } else {
      map.delete(conversationId);
    }
  }
}

/** Lo que el turno alcanzó a leer. Ausente si no llegó a abrir el historial. */
export type TurnoLeido = { vistos: string[] };

/**
 * Bloque 2 — El anuncio por el que «llegó» una conversación del Laboratorio. Solo vale con `is_test`: el
 * Laboratorio no escribe filas de `ad_attribution` (las leen Ajustes → Anuncios, las automatizaciones por
 * anuncio y el catálogo de Meta, y una simulación no debe tocar nada de eso).
 */
export type AnuncioSimulado = { sourceId: string; headline: string | null; body: string | null };

/**
 * Ejecuta UN turno del agente ahora (el Laboratorio lo llama directo, con
 * debounce 0 y sin pasar por el coalesce).
 *
 * 025 — `debidos` son los entrantes que este turno tiene que atender; solo los
 * pasa el coalesce. Devuelve qué entrantes leyó: quien lo llamó lo compara con
 * lo que entró mientras el modelo pensaba, que el turno no pudo ver.
 */
export async function runAgentTurn(
  conversationId: string,
  opciones: { debidos?: readonly string[]; anuncioSimulado?: AnuncioSimulado | null } = {}
): Promise<TurnoLeido | undefined> {
  const db = getDb();
  const convRows = await db
    .select()
    .from(schema.conversation)
    .where(eq(schema.conversation.id, conversationId))
    .limit(1);
  const conversation = convRows[0];
  if (!conversation) return;
  const organizationId = conversation.organizationId;

  // ¿Esta organización tiene IA? Lo guardado en Ajustes → IA, o si no, el
  // entorno. Sin proveedor, o con la llave pausada por el proveedor, el
  // mensaje se queda en la bandeja para que lo atienda una persona — y el
  // dueño ve el motivo en el banner y en Ajustes → IA. Va ANTES de cualquier
  // efecto (traspasos por ventana o por frase): sin IA no hay turno.
  if (!(await isAiConfiguredFor(organizationId))) return;

  // Condiciones de silencio: handoff activo o IA apagada en la conversación.
  if (conversation.handoffAt || !conversation.aiEnabled) return;

  const profileRows = await db
    .select()
    .from(schema.agentProfile)
    .where(scoped(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const profile = profileRows[0];
  if (!profile) return;
  // El toggle global aplica a conversaciones reales; el Laboratorio evalúa el
  // comportamiento configurado aunque el agente aún no esté encendido.
  if (!conversation.isTest && !profile.enabled) return;

  // Números ignorados: red de seguridad. `maybeRunAgentTurn` ya filtra antes de programar, pero un turno que se
  // programó (el debounce espera unos segundos) ANTES de que el dueño agregara el número llega hasta aquí. Se calla
  // sin traspaso ni acuse, y también si la lista no se pudo consultar. El Laboratorio no la aplica: sus contactos
  // son sintéticos.
  if (!conversation.isTest && (await isConversationSilenced(organizationId, conversationId))) return;

  // De qué anuncio llegó (si llegó de uno). Es contexto: si la consulta falla, el turno sigue sin él.
  // Bloque 2 — En el Laboratorio, el anuncio simulado de la corrida; en producción nunca (no es `is_test`).
  const attribution =
    conversation.isTest && opciones.anuncioSimulado
      ? opciones.anuncioSimulado
      : await getAttributionForConversation(organizationId, conversationId).catch((err) => {
          console.error("[agente] no se pudo leer el anuncio de origen:", err);
          return null;
        });

  // Enrutamiento por anuncio: si ese anuncio tiene un flujo activo, el agente persigue SU servicio u oferta.
  // Apagada `ATRIBUCION` no consulta nada; y un fallo degrada al comportamiento genérico del anuncio.
  const adFlow =
    attribution?.sourceId && atribucionEnabled()
      ? await getAdFlowContext(organizationId, attribution.sourceId).catch((err) => {
          console.error("[agente] no se pudo resolver el enrutamiento por anuncio:", err);
          return null;
        })
      : null;

  const recientes = await db
    .select()
    .from(schema.message)
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversationId)
      )
    )
    .orderBy(desc(schema.message.createdAt))
    .limit(20);
  recientes.reverse();
  // Por id y no solo «los últimos 20»: un mensaje debido que ya no quepa en
  // esa ventana seguiría debiéndose después de cada turno.
  const debidos = opciones.debidos?.length
    ? await db
        .select()
        .from(schema.message)
        .where(
          scoped(
            schema.message.organizationId,
            organizationId,
            and(
              eq(schema.message.conversationId, conversationId),
              eq(schema.message.direction, "in"),
              inArray(schema.message.id, [...opciones.debidos])
            )
          )
        )
    : [];
  const vigentes = debidosVigentes(recientes, debidos);
  const history = ordenarParaElTurno(recientes, vigentes);
  const lastInbound = [...history].reverse().find((m) => m.direction === "in");
  if (!lastInbound) return;
  const leido: TurnoLeido = {
    vistos: history.filter((m) => m.direction === "in").map((m) => m.id),
  };

  // Una persona contestó desde la bandeja antes de que este turno arrancara:
  // lo que lo provocó ya está atendido. Solo en el camino del coalesce (el
  // que trae debidos); el Laboratorio no tiene quien conteste a mano.
  if (opciones.debidos && !vigentes.length && atendidoPorPersona(recientes)) {
    return leido;
  }

  // Ventana cerrada: el agente JAMÁS envía texto libre → handoff 'ventana'.
  if (
    !conversation.isTest &&
    !isWindowOpen(
      conversation.lastInboundAt,
      new Date(),
      windowMsFor(conversation.channel)
    )
  ) {
    await applyHandoff(conversationId, organizationId, "ventana");
    return leido;
  }

  // Patrón de respaldo ANTES del LLM (FR-022). Avisa y traspasa, en el mismo
  // orden que el camino del modelo (`farewell` y luego handoff): callar ante
  // quien pide una persona se lee como que el bot dejó de contestar.
  if (lastInbound.text && matchesHandoffIntent(lastInbound.text)) {
    await acknowledgeHandoff(conversation);
    await applyHandoff(conversationId, organizationId, "cliente");
    return leido;
  }

  const kb = await db
    .select()
    .from(schema.kbEntry)
    .where(scoped(schema.kbEntry.organizationId, organizationId))
    .orderBy(asc(schema.kbEntry.createdAt));
  const stages = await db
    .select({ id: schema.pipelineStage.id, name: schema.pipelineStage.name })
    .from(schema.pipelineStage)
    .where(scoped(schema.pipelineStage.organizationId, organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  // Mejora 5 — Un conocimiento por encima del tope se recorta en el prompt: que quede registrado.
  const kbOmitidas = renderKbForPrompt(kb).omitted;
  if (kbOmitidas > 0) {
    console.warn(
      `[agente] ${organizationId}: el conocimiento pasa del tope; ${kbOmitidas} entrada(s) no entran al prompt.`
    );
  }

  // La agenda del agente exige la bandera Y que el plan la incluya (sin plan, sin restricción).
  const agenda = agendaEnabled() && (await getPlanAccess(organizationId).then((a) => a.unrestricted || a.modules.includes("agenda")));

  /**
   * 015 — Los huecos vigentes, con su instante exacto.
   *
   * `book_slot` exige el `startUtc` y `findOffered` compara por epoch, sin
   * tolerancia. Pero al modelo solo le llegaban el prompt y el historial de
   * TEXTO, donde están las etiquetas que leyó el cliente —«lun 7 sep, 11:00»—
   * sin año, sin zona y sin la fecha de hoy. Con eso, acertar el instante era
   * cuestión de suerte: el rechazo caía siempre en `slot_not_offered`, cuyo
   * texto es fijo, y la conversación se quedaba en bucle repitiendo la lista.
   *
   * Es un agujero de INTEGRACIÓN: las pruebas de contrato pasan porque
   * inyectan el ISO correcto, que es justo lo que el modelo no tenía.
   *
   * Sin oferta vigente no se añade nada, así que el modelo sigue obligado a
   * ofrecer antes de reservar. Se entrega el catálogo COMPLETO, no solo los
   * tres que se enseñaron: si el cliente pide otro día, ese hueco ya estaba
   * registrado como ofrecido y ahora el modelo también lo conoce.
   *
   * Reportado por @Diony7004 en #50, con el diagnóstico ya hecho.
   */
  const ofertas = agenda ? await getOffers(organizationId, conversationId) : [];
  const mapaDeHuecos = mapaDeHuecosParaModelo(ofertas);
  // Quiénes reciben citas: el modelo solo puede pedir «con Ana» si sabe que Ana existe (y su id). Un fallo
  // aquí deja al agente sin esa opción, no sin agenda.
  const equipoAgenda = agenda
    ? await bookableStaff(organizationId).catch((err) => {
        console.error("[agente] no se pudo leer el equipo de la agenda:", err);
        return [] as { id: string; name: string }[];
      })
    : [];

  /**
   * 031 — Módulo SALON: si el mensaje trae la palabra clave de un combo activo
   * (el texto que un anuncio de Meta/TikTok precarga), este turno recibe la
   * orden de saludar reconociendo la promoción. Apagado, no consulta nada. Un
   * fallo aquí degrada (el agente responde sin la instrucción), nunca tumba el turno.
   */
  // Con enrutamiento por anuncio la directiva del flujo ya fija el objetivo: no se duplica con la del combo.
  const instruccionCombo = salonEnabled() && !adFlow
    ? await getComboTriggerInstruction(organizationId, lastInbound.text).catch((err) => {
        console.error("[agente] no se pudo evaluar la oferta del anuncio:", err);
        return null;
      })
    : null;

  // Mejora 1 — El «ahora» del negocio (fecha, hora, zona y, con agenda, su horario). Nunca lanza.
  const temporal = await loadTemporalContext(organizationId, { agenda });
  // Mejora 10 — Los pies de foto de los adjuntos del historial (solo si hay adjuntos).
  const captions = await captionsDe(organizationId, history);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildAgentSystemPrompt({
        profile,
        kb,
        stages,
        agenda,
        agendaStaff: equipoAgenda,
        anuncio: attribution ? { headline: attribution.headline, body: attribution.body } : null,
        adFlow,
        contextoTemporal: temporal,
      }),
    },
    // Mejora 10 — Ningún mensaje se descarta por no tener texto: una nota de voz o una foto llegan como un
    // marcador («[El cliente envió una imagen con este texto: …]») que el prompt enseña a manejar.
    ...history.flatMap((m) => {
      const content = textoParaModelo({
        direction: m.direction,
        type: m.type,
        text: m.text,
        caption: m.mediaAssetId ? (captions.get(m.mediaAssetId) ?? null) : null,
      });
      return content
        ? [{ role: m.direction === "in" ? ("user" as const) : ("assistant" as const), content }]
        : [];
    }),
    /**
     * Va AL FINAL, después del historial: es el estado de AHORA, y ponerlo
     * antes lo dejaría enterrado bajo la conversación en cuanto esta crezca.
     */
    ...(mapaDeHuecos
      ? [{ role: "system" as const, content: mapaDeHuecos }]
      : []),
    ...(instruccionCombo ? [{ role: "system" as const, content: instruccionCombo }] : []),
    // 029 — Lo último que lee el modelo: contestar con el JSON de la acción.
    { role: "system", content: TURN_FORMAT_REMINDER },
  ];

  // Monedas: ¿alcanza el saldo? Con el corte activo y sin saldo el agente se calla (sin traspaso ni acuse: el turno
  // cuenta como leído, así que tampoco hay bucle). Apagadas las monedas, no hace nada y no toca la base.
  const meter = await beginAiTurnMeter({
    organizationId,
    conversationId,
    lastInboundId: lastInbound.id,
    isTest: conversation.isTest,
  });
  if (meter.blocked) return leido;

  const esquemaTurno = agentActionSchema(agenda) as z.ZodType<AgentActionType>;
  const result = await chatJson(esquemaTurno, messages, {
    organizationId,
    usage: meter.usage,
  });
  if (!result.ok) {
    // Sin respuesta válida no hay cobro (`settle` solo cobra un `ok`); se asienta igual para la medición.
    await meter.settle(result);
    if (result.error === "not_configured") return leido;
    // Fallo persistente del proveedor o salida imposible → escalar (FR-022).
    console.error(`[agente] fallo del proveedor (raw): ${result.detail}`);
    await applyHandoff(conversationId, organizationId, "error");
    return leido;
  }

  // Bloque 2 — Anuncio EXCLUSIVO: la directiva del prompt no basta como garantía. Se revisa lo que saldría
  // (otro servicio ofrecido o cotizado), con un reintento corregido y, si no basta, una respuesta segura.
  const turno = await reforzarExclusivo({
    organizationId,
    conversationId,
    adFlow,
    result,
    schema: esquemaTurno,
    messages,
    ultimoDelCliente: lastInbound.text,
    usage: meter.usage,
  });

  // Mejora 11 — La llamada al modelo (con reintentos) puede tardar minutos. Antes de actuar se relee el estado:
  // si apagaron la IA, la traspasaron, se apagó el agente o una persona contestó desde la Bandeja, el agente no
  // habla encima. Tampoco se cobra: no se entregó nada.
  const vigencia = await revalidarTurno({
    organizationId,
    conversationId,
    desde: lastInbound.createdAt,
  });
  if (!vigencia.ok) {
    console.info(
      `[agente] ${conversationId}: turno cancelado antes de enviar (${vigencia.motivo}); no se envía ni se cobra.`
    );
    return leido;
  }

  const entrega: EstadoEntrega = { fallo: false };
  await ejecutarAccion(
    { conversation, action: turno.data, agenda, equipoAgenda, adFlow, stages },
    entrega
  );
  // Mejora 7 — Se cobra lo que llegó al cliente. Si el envío falló (y ya se traspasó y avisó al equipo), el
  // turno no se cobra; lo que el modelo gastó queda medido en `credit_usage` igual.
  if (entrega.fallo) {
    console.warn(`[agente] ${conversationId}: la respuesta no se entregó; el turno no se cobra.`);
  } else {
    await meter.settle(result);
  }
  return leido;
}

type Conversation = typeof schema.conversation.$inferSelect;
type EstadoEntrega = { fallo: boolean };

/** Mejora 10 — Pie de foto por adjunto. Contexto: un fallo deja los marcadores sin pie, nunca tumba el turno. */
async function captionsDe(
  organizationId: string,
  mensajes: readonly { mediaAssetId: string | null }[]
): Promise<Map<string, string>> {
  const ids = [...new Set(mensajes.map((m) => m.mediaAssetId).filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  try {
    const rows = await getDb()
      .select({ id: schema.mediaAsset.id, caption: schema.mediaAsset.caption })
      .from(schema.mediaAsset)
      .where(scoped(schema.mediaAsset.organizationId, organizationId, inArray(schema.mediaAsset.id, ids)));
    return new Map(rows.filter((r) => r.caption).map((r) => [r.id, r.caption!]));
  } catch (err) {
    console.error("[agente] no se pudieron leer los pies de foto del historial:", err);
    return new Map();
  }
}

/** La acción validada del modelo, ejecutada. `entrega.fallo` = algún mensaje no llegó al cliente. */
async function ejecutarAccion(
  ctx: {
    conversation: Conversation;
    action: AgentActionType;
    agenda: boolean;
    equipoAgenda: { id: string; name: string }[];
    adFlow: Awaited<ReturnType<typeof getAdFlowContext>> | null;
    stages: { id: string; name: string }[];
  },
  entrega: EstadoEntrega
): Promise<void> {
  const { conversation, agenda, equipoAgenda, adFlow, stages } = ctx;
  const organizationId = conversation.organizationId;
  const conversationId = conversation.id;
  let action = ctx.action;
  const entregar = async (text: string, opts: { traspasarSiFalla?: boolean } = {}) => {
    if ((await deliverReply(conversation, text, opts)) !== "entregado") entrega.fallo = true;
  };

  // 015 — Agenda. Un fallo del motor degrada el turno (el agente responde sin
  // agendar), nunca lo tumba: quedarse callado es peor que no agendar.
  if (action.action === "offer_slots" || action.action === "book_slot") {
    if (!agenda) {
      action = degradeAction(action);
    } else {
      try {
        // «Con Ana»: solo un id que el sistema le dio; uno inventado se ignora (atiende quien esté libre).
        const pedido = "staffId" in action ? action.staffId : undefined;
        const staffId = pedido && equipoAgenda.some((m) => m.id === pedido) ? pedido : undefined;
        const turn =
          action.action === "offer_slots"
            ? await offerSlots({
                organizationId,
                conversationId,
                intro: action.reply,
                // Se ofrece lo que cabe para el servicio del anuncio (su duración y quién lo da).
                ...bookingTargetOf(adFlow),
                staffId,
              })
            : await bookSlot({
                organizationId,
                conversationId,
                startUtc: action.startUtc,
                confirmation: action.reply,
                // La cita queda atribuida al servicio u oferta del anuncio.
                ...bookingTargetOf(adFlow),
                staffId,
              });
        await entregar(turn.text);
        if (turn.ok) {
          publish(organizationId, {
            type: "conversation.updated",
            data: { conversation: { id: conversationId } },
          });
        }
        return;
      } catch (err) {
        console.error(`[agente] el motor de agenda falló: ${err}`);
        action = degradeAction(action);
      }
    }
  }

  if (action.action === "move_stage") {
    const stage = resolveStage(action.stage, stages);
    if (!stage) {
      action = degradeAction(action);
    } else {
      await moveLeadToStage(organizationId, conversation.contactId, stage.id);
      publish(organizationId, {
        type: "conversation.updated",
        data: { conversation: { id: conversationId } },
      });
      if (action.reply) await entregar(action.reply);
      return;
    }
  }

  switch (action.action) {
    case "none":
      return;
    case "reply":
      await entregar(action.text);
      return;
    case "update_lead":
      await appendLeadNote(organizationId, conversation.contactId, action.note);
      if (action.reply) await entregar(action.reply);
      return;
    case "handoff":
      // El traspaso va igual: si la despedida no sale, no se traspasa dos veces por «error».
      if (action.farewell) await entregar(action.farewell, { traspasarSiFalla: false });
      await applyHandoff(conversationId, organizationId, "modelo");
      return;
  }
}

/**
 * Entrega la respuesta: envío real o persistencia sandbox (is_test). Nunca lanza.
 *
 * Mejora 7 — La respuesta se parte para que quepa en el canal (WhatsApp: 4096 caracteres; hasta
 * `MAX_PARTES_RESPUESTA` mensajes). Si el envío falla por algo que no sea la ventana cerrada o el tope de
 * mensajes del canal, se registra con su código y se traspasa por `error` (eso avisa al equipo): nadie se
 * queda sin respuesta en silencio. `traspasarSiFalla: false` cuando quien llama traspasa igual después.
 */
async function deliverReply(
  conversation: Conversation,
  text: string,
  opts: { traspasarSiFalla?: boolean } = {}
): Promise<"entregado" | "fallido"> {
  const partes = partirParaCanal(text, (t) => textFits(conversation.channel, t));
  if (conversation.isTest) {
    for (const parte of partes) await persistTestOutbound(conversation, parte);
    return "entregado";
  }
  for (const [i, parte] of partes.entries()) {
    try {
      await sendText({
        conversationId: conversation.id,
        organizationId: conversation.organizationId,
        text: parte,
        aiGenerated: true,
      });
    } catch (err) {
      if (err instanceof SendError && err.code === "window_closed") {
        await applyHandoff(conversation.id, conversation.organizationId, "ventana").catch((e) =>
          console.error(`[agente] no se pudo traspasar ${conversation.id} por ventana:`, e)
        );
        return "fallido";
      }
      // 022 — El canal ya no admite más mensajes hasta que el cliente escriba
      // (el tope de TikTok). No se traspasa: dejaría la IA en pausa para siempre
      // por algo que se arregla solo con el siguiente mensaje del cliente.
      if (err instanceof SendError && err.code === "message_limit") {
        console.warn(
          `[agente] ${conversation.id}: ${err.message}. No se envía y la IA sigue activa.`
        );
        return "fallido";
      }
      const codigo = err instanceof SendError ? err.code : "inesperado";
      console.error(
        `[agente] no se pudo enviar la respuesta de la IA en ${conversation.id} (parte ${i + 1}/${partes.length}, ${codigo}):`,
        err instanceof Error ? err.message : err
      );
      if (opts.traspasarSiFalla !== false) {
        await applyHandoff(conversation.id, conversation.organizationId, "error").catch((e) =>
          console.error(`[agente] tampoco se pudo traspasar ${conversation.id}:`, e)
        );
      }
      return "fallido";
    }
  }
  return "entregado";
}

/**
 * FR-022 — El acuse del patrón de respaldo, antes de traspasar.
 *
 * Sale por `deliverReply`, el mismo camino que el `farewell` del modelo, así
 * que hereda sus garantías: una conversación del Laboratorio lo persiste sin
 * tocar la API, y con la ventana de 24 h cerrada no sale texto libre (el turno
 * ya traspasó por `ventana` antes de llegar aquí, y el emisor lo rechazaría
 * igual). Tampoco se repite si el turno vuelve a correr: el traspaso deja
 * `handoffAt` puesto y el turno siguiente se calla en la primera comprobación,
 * igual que tras el `farewell`.
 *
 * Lo único que cambia respecto a ese camino: si el envío falla, el traspaso
 * se aplica IGUAL (y una sola vez, por `cliente`). Quien pidió una persona tiene
 * que llegar a una aunque el aviso no haya salido; dejarlo con la IA encendida
 * sería peor que el silencio.
 */
async function acknowledgeHandoff(conversation: Conversation): Promise<void> {
  try {
    const r = await deliverReply(conversation, HANDOFF_BACKUP_ACK, { traspasarSiFalla: false });
    if (r !== "entregado") {
      console.error(`[agente] el acuse del traspaso no salió en ${conversation.id}; se traspasa igual.`);
    }
  } catch (err) {
    console.error(
      `[agente] el acuse del traspaso no salió en ${conversation.id}; se traspasa igual:`,
      err
    );
  }
}

/** Mensaje saliente del sandbox: se persiste, JAMÁS toca la API (FR-031). */
async function persistTestOutbound(
  conversation: Conversation,
  text: string
): Promise<void> {
  const db = getDb();
  await db.insert(schema.message).values({
    id: newId("message"),
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    direction: "out",
    type: "text",
    text,
    status: "sent",
    aiGenerated: true,
    origin: "ai",
  });
  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(
      scoped(
        schema.conversation.organizationId,
        conversation.organizationId,
        eq(schema.conversation.id, conversation.id)
      )
    );
}

export async function applyHandoff(
  conversationId: string,
  organizationId: string,
  reason: "cliente" | "modelo" | "error" | "ventana"
): Promise<void> {
  const db = getDb();
  const updated = await db
    .update(schema.conversation)
    .set({ handoffAt: new Date(), handoffReason: reason, updatedAt: new Date() })
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId)
      )
    )
    .returning();
  if (!updated[0]) return;
  publish(organizationId, {
    type: "conversation.updated",
    data: {
      conversation: { id: conversationId, handoffReason: reason },
    },
  });
  await notifyHandoff(organizationId, conversationId, reason);
}

async function moveLeadToStage(
  organizationId: string,
  contactId: string,
  stageId: string
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.lead.contactId, contactId)
      )
    )
    .limit(1);
  const leadId = rows[0]?.id;
  if (!leadId) return;

  // Por la puerta única: el agente mueve tarjetas igual que el dueño, y su
  // movimiento tiene que quedar en la bitácora o el embudo mentirá sobre
  // quién hizo avanzar cada lead.
  await moveLeadThroughHistory({
    organizationId,
    leadId,
    toStageId: stageId,
    source: "bot",
    extra: { lastActivityAt: new Date() },
    // El agente no clasifica pérdidas: si su etapa destino resultara ser la
    // perdida, la puerta lo rechaza y el lead se queda donde está — mejor eso
    // que un motivo inventado.
  });
}

async function appendLeadNote(
  organizationId: string,
  contactId: string,
  note: string
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.contact.id, notes: schema.contact.notes })
    .from(schema.contact)
    .where(scoped(schema.contact.organizationId, organizationId, eq(schema.contact.id, contactId)))
    .limit(1);
  const contact = rows[0];
  if (!contact) return;
  // Mejora 2 — Sin repetir la misma nota y con tope de notas `[IA]` (las de las personas no se tocan).
  const notes = appendAiNote(contact.notes, note);
  if (notes === null) return;
  await db
    .update(schema.contact)
    .set({ notes, updatedAt: new Date() })
    .where(scoped(schema.contact.organizationId, organizationId, eq(schema.contact.id, contact.id)));
}
