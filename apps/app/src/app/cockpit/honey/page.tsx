import { EngineChat } from "@/components/cockpit/engine-chat";
import { HONEY_AGUI_URL } from "@/lib/copilotkit-runtime-options";

// Honey tab — chat surface against the Honey engine's AG-UI endpoint
// (agentic-stack honey_agui adapter, :8126). The named runtime agent
// "honey" proxies runs to it; provider keys are not needed here.
export default function HoneyPage() {
  return (
    <EngineChat
      agentId="honey"
      title="Honey"
      endpoint={HONEY_AGUI_URL}
      welcome="Honey, here. What needs us?"
      placeholder="Talk to Honey…"
    />
  );
}
