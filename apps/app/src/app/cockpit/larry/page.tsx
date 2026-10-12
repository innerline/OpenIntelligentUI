import { EngineChat } from "@/components/cockpit/engine-chat";
import { LARRY_AGUI_URL } from "@/lib/copilotkit-runtime-options";

// Larry tab — same pattern as Honey, against the larry-agui adapter
// (:8127). One adapter shape, two personas.
export default function LarryPage() {
  return (
    <EngineChat
      agentId="larry"
      title="Larry"
      endpoint={LARRY_AGUI_URL}
      welcome="Larry, here. What are we digging into?"
      placeholder="Talk to Larry…"
    />
  );
}
