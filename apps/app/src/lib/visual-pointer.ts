// Visual pointer (kanban/device-input-matrix slice 2, 2026-10-18) — the
// machine line a persona ENDS a reply with:
//
//   VISUAL: map=Vision/Agent Visuals/example.excalidraw.md
//   VISUAL: plex=K-Plex/Mind Map.md
//   VISUAL: file=kanban/device-input-matrix.md
//
// The adapter strips the line from everything the owner reads and
// carries the parsed pointer on RUN_FINISHED's result (the same metadata
// lane the device tag established, now engine -> cockpit). This module
// is the cockpit-side half: the type guard, the per-persona slot store
// (localStorage, same lane as the thread pin), and the window event
// that hands a fresh pointer from the chat surface to the docked
// sidebar — which renders it as Honey's pointing surface.

export type VisualPointer = { kind: "map" | "plex" | "file"; path: string };

export type VisualAgent = "honey" | "larry" | "pi";

// The chat surfaces dispatch; the docked sidebar listens (same pattern
// as the existing "cockpit-ask-honey" hand-off).
export const VISUAL_EVENT = "cockpit-visual";

export function isVisualPointer(v: unknown): v is VisualPointer {
  if (!v || typeof v !== "object") return false;
  const p = v as { kind?: unknown; path?: unknown };
  return (
    (p.kind === "map" || p.kind === "plex" || p.kind === "file") &&
    typeof p.path === "string" &&
    p.path.length > 0
  );
}

// One slot per persona: the sidebar docks beside whichever chat surface
// is on stage, and each persona points at its own artifacts.
export function visualSlotKey(agent: VisualAgent): string {
  return "cockpit.visual." + agent;
}

export function readVisualSlot(agent: VisualAgent): VisualPointer | null {
  try {
    const raw = window.localStorage.getItem(visualSlotKey(agent));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isVisualPointer(parsed) ? parsed : null;
  } catch {
    // blocked storage or corrupt entry — nothing pointed at, for now
    return null;
  }
}

// Writing null CLEARS the slot: the latest reply genuinely pointed at
// nothing, and the sidebar must not linger on an older artifact.
export function writeVisualSlot(agent: VisualAgent, visual: VisualPointer | null): void {
  try {
    if (visual === null) window.localStorage.removeItem(visualSlotKey(agent));
    else
      window.localStorage.setItem(
        visualSlotKey(agent),
        JSON.stringify(visual),
      );
  } catch {
    // private-mode Safari — the live event below still updates the sidebar
  }
  // localStorage fires `storage` in OTHER tabs only — dispatch the
  // synthetic event so same-tab subscribers (the pointing section's
  // useSyncExternalStore) re-read the slot now. Same trick as the
  // sidebar's width/open store.
  window.dispatchEvent(new Event("storage"));
}

export function dispatchVisual(
  agent: VisualAgent,
  visual: VisualPointer | null,
): void {
  window.dispatchEvent(
    new CustomEvent(VISUAL_EVENT, { detail: { agent, visual } }),
  );
}

// One lane for both paths that learn a pointer: persist + announce.
export function publishVisual(
  agent: VisualAgent,
  visual: VisualPointer | null,
): void {
  writeVisualSlot(agent, visual);
  dispatchVisual(agent, visual);
}
