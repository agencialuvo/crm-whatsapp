import { PipelineClient } from "@/components/pipeline/pipeline-client";
import { CHANNEL_ORDER } from "@/lib/channels";
import { enabledChannels } from "@/server/channels/enabled";

export const dynamic = "force-dynamic";

export default function PipelinePage() {
  // Qué canales existen se decide en el servidor (igual que en la Bandeja): el filtro de canal solo aparece
  // cuando hay más de uno.
  const enabled = enabledChannels();
  const channels = CHANNEL_ORDER.filter((c) => enabled.has(c));
  return <PipelineClient channels={channels} />;
}
