"use client";

import Link from "next/link";
import "./cockpit.css";

// Tasks tab — placeholder surface. The vault's task board is the MWP
// kanban/ (cards with status: properties); /api/board currently surfaces
// only the needs/runs slices, not per-card columns. Nothing is faked
// here: the grid is labeled as unwired, and the real "what needs me"
// list lives one tab over until the kanban read lands.

const COLUMNS = [
  { key: "todo", label: "To do", note: "cards at status: todo / open" },
  { key: "doing", label: "Doing", note: "cards at status: doing / run" },
  { key: "review", label: "Review", note: "cards parked at a review gate" },
  { key: "done", label: "Done", note: "closed cards with receipts" },
];

export function TasksView() {
  return (
    <div className="cockpit-tasks">
      <div className="cockpit-chat-head" style={{ padding: 0 }}>
        <h1>Tasks</h1>
        <span className="cockpit-chat-sub">
          <span className="cockpit-unwired">wiring: MWP kanban (next pass)</span>
        </span>
      </div>
      <div className="cockpit-tasks-grid">
        {COLUMNS.map((c) => (
          <div key={c.key} className="cockpit-task-col" aria-label={c.label}>
            <h3>{c.label}</h3>
            <p>
              {c.note}
              <br />
              <span className="cockpit-unwired" style={{ marginTop: 4 }}>
                not wired
              </span>
            </p>
          </div>
        ))}
      </div>
      <p className="dash-dim">
        No task data is shown because none is wired yet — nothing faked. Live owner
        actions live on the{" "}
        <Link href="/cockpit/boards" style={{ color: "var(--ck-accent)" }}>
          Boards
        </Link>{" "}
        tab (needs me / runs with receipts); the card columns land when the kanban
        read is added to /api/board.
      </p>
    </div>
  );
}
