"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { PlexPanel } from "@/components/kplex/plex-panel";
import "./cockpit.css";

// Visuals as a large right sidebar (owner directive 2026-10-12): the
// k-plex panel docks alongside the chat surfaces instead of owning a
// tab. Docked in the cockpit LAYOUT so it survives Honey ↔ Larry
// navigation without losing the walk; when not docked (Boards) it is
// hidden with CSS, not unmounted, so the walk survives the detour.
// Open/closed persists in localStorage and is read through
// useSyncExternalStore — the remembered state is an external store, not
// component state, so nothing re-renders on mount cascades. Old
// /cockpit/visuals links land on Honey with the sidebar forced open
// (?visuals=1).

const STORAGE_KEY = "cockpit:visuals-open";

// Drag-to-resize (owner ask 2026-10-12): the sidebar's left edge is a
// col-resize gutter — pointer drag (mouse, touch, pencil) resizes between
// MIN_W and 70% of the viewport; the committed width persists in
// localStorage; double-click the gutter to reset to the CSS default.
// During the drag the width is applied straight to the element (zero
// React renders mid-gesture); React state only takes the committed value
// on pointer-up.
const WIDTH_KEY = "cockpit:visuals-width";
const MIN_W = 320;
const MAX_W = 1100;
const clampWidth = (w: number) =>
  Math.round(Math.min(Math.max(w, MIN_W), Math.min(MAX_W, window.innerWidth * 0.7)));

// The vault's Excalidraw diagram sources — carried over from the old
// Visuals tab; link-outs open read-only through the receipt door, editing
// stays in Obsidian where the files are canonical.
const DIAGRAM_SOURCES = [
  { title: "The Big Vision", path: "Vision/The Big Vision.excalidraw.md" },
  { title: "How work flows", path: "Vision/Platform Map/How work flows.excalidraw.md" },
  {
    title: "meta-maps green-field plex",
    path: "Vision/Agent Visuals/meta-maps-green-field-plex.excalidraw.md",
  },
];

// localStorage as an external store: same-tab writes dispatch a synthetic
// `storage` event (real ones only fire in other tabs).
function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function VisualsSidebar() {
  const pathname = usePathname();
  const docked =
    pathname === "/cockpit" ||
    pathname === "/cockpit/honey" ||
    pathname === "/cockpit/larry";
  const open = useSyncExternalStore(subscribe, readOpen, () => true);
  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  // Committed width loads once after mount (never during SSR render), so
  // server and client markup match.
  useEffect(() => {
    try {
      const w = Number(window.localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(w) && w >= MIN_W) setWidth(w);
    } catch {
      /* private-mode Safari — CSS default width applies */
    }
  }, []);

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const aside = asideRef.current;
    if (!aside) return;
    const startX = e.clientX;
    const startW = aside.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      // Right-docked: dragging the gutter left widens the sidebar.
      // flex shorthand + width together, so the class's 41%/680px cap
      // cannot fight the drag.
      const w = clampWidth(startW + (startX - ev.clientX));
      aside.style.flex = `0 0 ${w}px`;
      aside.style.width = `${w}px`;
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const w = clampWidth(startW + (startX - ev.clientX));
      setWidth(w);
      try {
        window.localStorage.setItem(WIDTH_KEY, String(w));
      } catch {
        /* private-mode Safari — width holds for this visit */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const resetWidth = () => {
    setWidth(null);
    try {
      window.localStorage.removeItem(WIDTH_KEY);
    } catch {
      /* private-mode Safari */
    }
    if (asideRef.current) {
      asideRef.current.style.flex = "";
      asideRef.current.style.width = "";
    }
  };

  // One-shot: old /cockpit/visuals links arrive with ?visuals=1 — force
  // the sidebar open (collapse is one tap) and clean the URL. Pure
  // external-system updates, no component state.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("visuals") !== "1") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* private-mode Safari — the panel still opens for this visit */
    }
    window.dispatchEvent(new Event("storage"));
    const url = new URL(window.location.href);
    url.searchParams.delete("visuals");
    window.history.replaceState({}, "", url);
  }, []);

  const toggle = (next: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* private-mode Safari — state just won't persist */
    }
    window.dispatchEvent(new Event("storage"));
  };

  return (
    <aside
      ref={asideRef}
      style={
        width
          ? { flex: `0 0 ${width}px`, width, minWidth: MIN_W, maxWidth: MAX_W }
          : undefined
      }
      className={
        "cockpit-visuals-sidebar" +
        (open ? "" : " sidebar-closed") +
        (docked ? "" : " sidebar-undocked")
      }
      aria-label="Visuals — k-plex walk"
    >
      {open && docked && (
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the visuals sidebar"
          title="Drag to resize · double-click to reset"
          onPointerDown={startDrag}
          onDoubleClick={resetWidth}
        />
      )}
      <button
        className="sidebar-rail"
        onClick={() => toggle(true)}
        title="Open the visuals sidebar"
        tabIndex={open ? -1 : 0}
      >
        <span className="sidebar-rail-mark" aria-hidden>
          ◂
        </span>
        <span className="sidebar-rail-label">visuals</span>
      </button>
      <div className="sidebar-body">
        <div className="sidebar-head">
          <b>visuals · k-plex</b>
          <button
            className="sidebar-collapse"
            onClick={() => toggle(false)}
            title="Collapse the visuals sidebar"
          >
            collapse ▸
          </button>
        </div>
        <div className="sidebar-plex">
          <PlexPanel variant="stage" />
        </div>
        <nav className="cockpit-links sidebar-diagrams" aria-label="vault diagram sources">
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
        </nav>
      </div>
    </aside>
  );
}
