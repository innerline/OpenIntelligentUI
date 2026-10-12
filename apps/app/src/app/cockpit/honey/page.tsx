import { EngineChat } from "@/components/cockpit/engine-chat";
import { TasksPanel } from "@/components/cockpit/tasks-panel";
import { HONEY_AGUI_URL } from "@/lib/copilotkit-runtime-options";

// Honey surface — chat against the Honey engine's AG-UI endpoint
// (agentic-stack honey_agui adapter, :8126) with her REAL task panel
// embedded below: the MWP vault kanban, read live from /api/board.
// The Visuals sidebar docks to the right of this surface (layout).
// Deep links: ?q=<text> sends <text> as the first message (the Visuals
// sidebar's "ask Honey about this node" hand-off).
export default function HoneyPage() {
  return (
    <div className="cockpit-chatpage">
      <EngineChat
        agentId="honey"
        title="Honey"
        endpoint={HONEY_AGUI_URL}
        welcome="Honey, here. What needs us?"
        placeholder="Talk to Honey…"
      />
      <TasksPanel source="honey" />
    </div>
  );
}
