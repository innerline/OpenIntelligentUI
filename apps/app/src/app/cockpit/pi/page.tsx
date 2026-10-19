import { EngineChat } from "@/components/cockpit/engine-chat";
import { PI_AGUI_URL } from "@/lib/copilotkit-runtime-options";

// Pi surface — the smallest visible loop (pi-platform WO 2026-10-18):
// a Pydantic-AI agent behind the native AG-UI adapter whose one tool
// hands real jobs to headless Pi (shell+files) and validates every
// result against the SubAgentResult contract. Chat + live tool event
// stream, same wire as Honey/Larry.
export default function PiPage() {
  return (
    <div className="cockpit-chatpage">
      <EngineChat
        agentId="pi"
        title="Pi"
        endpoint={PI_AGUI_URL}
        welcome="Pi seat, live. Hand me a job — I run it through headless Pi and bring back the typed result."
        placeholder="Give Pi a job…"
      />
    </div>
  );
}
