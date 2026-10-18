"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { doorUrl } from "@/lib/vault-links";
import { honeyuiPageUrl } from "@/lib/honeyui-proxy";
import {
  isVisualPointer,
  visualSlotKey,
  type VisualAgent,
  type VisualPointer,
} from "@/lib/visual-pointer";
import "./cockpit.css";

// Honey's pointing surface (kanban/device-input-matrix slice 2, owner
// refinement 2026-10-18: "the right sidebar is HONEY'S visual pointing
// surface — Honey shows what she's referring to; the owner does not edit
// in it; he CLICKS an item and is taken to the full Excalidraw or K-Plex
// view"). When a reply ends with a VISUAL machine line, the adapter
// carries the pointer here and this section renders the artifact:
//
//   map/plex — the honeyui render embedded through the cockpit proxy
//              (token inlined server-side; the iframe URL IS the
//              click-through URL — same link, full page, new tab)
//   file     — a KEYED reader (fresh mount per path) previewing the
//              note via the receipt route; click-through opens the
//              app's own /vault viewer (full page, new tab)
//
// No pointer in the latest reply -> the section rests at its hint line;
// it never lingers on an older artifact (publishVisual writes null).

const KIND_LABEL: Record<VisualPointer["kind"], string> = {
  map: "excalidraw",
  plex: "k-plex",
  file: "note",
};

// The slot is an external store, same rules as the sidebar's open/width:
// the raw string is the snapshot (referentially stable), parsed with
// useMemo. publishVisual's write dispatches the synthetic `storage`
// event, so same-tab publishes notify like cross-tab ones do.
function subscribeSlot(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function FilePreview({ path }: { path: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/board/receipt?file=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (error) return <p className="pointed-error">{error}</p>;
  if (text === null) return <p className="pointed-hint">reading the note…</p>;
  const capped = text.slice(0, 8000);
  return (
    <pre className="pointed-file">
      {capped}
      {text.length > capped.length ? "\n…" : ""}
    </pre>
  );
}

export function PointedVisual({ agent }: { agent: VisualAgent }) {
  const raw = useSyncExternalStore(
    subscribeSlot,
    () => {
      try {
        return window.localStorage.getItem(visualSlotKey(agent));
      } catch {
        return null; // blocked storage — nothing pointed at, for now
      }
    },
    () => null,
  );
  const visual = useMemo(() => {
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isVisualPointer(parsed) ? parsed : null;
    } catch {
      return null; // corrupt entry — rest at the hint, never crash
    }
  }, [raw]);

  const href = !visual
    ? null
    : visual.kind === "file"
      ? doorUrl(visual.path)
      : honeyuiPageUrl(visual.kind, visual.path);

  return (
    <section className="pointed-visual" aria-label="what the answer points at">
      {visual && href ? (
        <>
          <a
            className="pointed-title"
            href={href}
            target="_blank"
            rel="noopener"
            title={`${visual.path} — open the full view`}
            data-testid="pointed-open"
          >
            <span className="pointed-kind">{KIND_LABEL[visual.kind]}</span>
            <span className="pointed-path">{visual.path}</span>
            <span className="pointed-cta" aria-hidden>
              ↗
            </span>
          </a>
          {visual.kind === "file" ? (
            <FilePreview key={visual.path} path={visual.path} />
          ) : (
            <iframe
              className="pointed-frame"
              src={href}
              title={`${KIND_LABEL[visual.kind]} render of ${visual.path}`}
              loading="lazy"
            />
          )}
        </>
      ) : (
        <p className="pointed-hint">
          {agent === "honey" ? "Honey's" : "Larry's"} answers point their
          visuals here — ask about something in the vault.
        </p>
      )}
    </section>
  );
}
