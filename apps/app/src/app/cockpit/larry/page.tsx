import { EngineChat } from "@/components/cockpit/engine-chat";
import { TasksPanel } from "@/components/cockpit/tasks-panel";
import { LARRY_AGUI_URL } from "@/lib/copilotkit-runtime-options";

// Larry surface — PRE-LIVE PREVIEW, deliberately NOT presented as Honey's
// twin. Owner ruling (weeks standing, restated 2026-10-11/12): Larry is
// nothing like Honey — very different backend. Larry's real engine
// (local-first at go-live, Personal vault / myPKA team, own relay :3100
// per plan) is NOT built yet. What answers here today is a temporary
// Honey-shaped preview adapter (honey_agui with HONEY_AGENT=larry over
// the Personal vault). The banner below says exactly that in the UI —
// no fake parity.
// His task panel is his OWN source (Larry ≠ Honey): the Personal vault
// myPKA task system via /api/larry-tasks, read-only.
export default function LarryPage() {
  return (
    <div className="cockpit-chatpage">
      <EngineChat
        agentId="larry"
        title="Larry (pre-live preview)"
        endpoint={LARRY_AGUI_URL}
        welcome="Preview lane. Larry's real engine is not built yet — go-live brings his own: local-first models, the Personal vault, his relay."
        placeholder="Preview only — Talk to Larry…"
        notice="PRE-LIVE PREVIEW — this is a temporary adapter shaped like Honey's. Larry's actual backend (local models at go-live, Personal vault, own relay) is not built. He is not Honey and will not stay this shape."
      />
      <TasksPanel source="larry" />
    </div>
  );
}
