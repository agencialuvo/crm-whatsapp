import { InboxClient } from "@/components/inbox/inbox-client";
import { canConfigure } from "@/lib/auth/roles";
import { getSessionOrNull } from "@/lib/auth/session";
import { CHANNEL_ORDER } from "@/lib/channels";
import { enabledChannels } from "@/server/channels/enabled";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  /**
   * 014 — Qué bandejas existen se decide en el servidor, no mirando los datos.
   * Si se dedujera de las conversaciones cargadas, la marca de canal aparecería
   * y desaparecería sola: una instancia con Instagram encendido pero sin DMs
   * todavía se vería como una instancia de un solo canal, y el primer mensaje
   * repintaría la lista entera.
   */
  const enabled = enabledChannels();
  const channels = CHANNEL_ORDER.filter((c) => enabled.has(c));

  // 026 — Eliminar una conversación es de quien administra el negocio. El
  // servidor lo exige en la ruta; esto solo decide si la opción se enseña.
  const session = await getSessionOrNull();

  // Ignorar a un contacto (que el agente no le conteste) también es de quien configura.
  return <InboxClient channels={channels} canDelete={canConfigure(session?.role)} canIgnore={canConfigure(session?.role)} />;
}
