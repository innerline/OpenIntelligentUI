"use client";

import { PlexPanel } from "@/components/kplex/plex-panel";
import "./cockpit.css";

// Visuals tab — the k-plex panel promoted from sidebar to main surface:
// parents above / friends left / center / children below + challengers
// right, node-click walking, vault search, follow-Honey mode. "Ask Honey
// about this node" hands off to the Honey tab when no chat input lives on
// the page. Link-outs are the vault's own diagram sources (Excalidraw
// files open read-only through the receipt door) — no editor is built
// here; that surface stays in Obsidian where the files are canonical.

const DIAGRAM_SOURCES = [
  { title: "The Big Vision", path: "Vision/The Big Vision.excalidraw.md" },
  { title: "How work flows", path: "Vision/Platform Map/How work flows.excalidraw.md" },
  {
    title: "meta-maps green-field plex",
    path: "Vision/Agent Visuals/meta-maps-green-field-plex.excalidraw.md",
  },
];

export function VisualsView() {
  return (
    <div className="cockpit-visuals">
      <div className="plex-stage">
        <PlexPanel variant="stage" />
      </div>
      <nav className="cockpit-links" aria-label="vault diagram sources">
        <span className="dz-tag">diagrams</span>
        {DIAGRAM_SOURCES.map((d) => (
          <a
            key={d.path}
            href={`/api/board/receipt?file=${encodeURIComponent(d.path)}`}
            target="_blank"
            rel="noopener"
            title={d.path}
          >
            {d.title} ↗
          </a>
        ))}
        <span className="dz-tag" style={{ marginLeft: 8 }}>
          source files · edit in obsidian
        </span>
      </nav>
    </div>
  );
}
