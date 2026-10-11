"use client";

// K-Plex panel — the plex walk rendered inside the Intelligence UI.
// Owner direction 2026-10-11: agents create visuals with their text in
// k-plex format; Brian engages them in k-plex; k-plex runs outside
// Obsidian. This panel is that surface: walk the graph, click nodes,
// ask Honey about whatever you're standing on, and (follow mode) land on
// whatever vault path Honey's latest answer points at.

import { useCallback, useEffect, useMemo, useState } from "react";
import "./plex-panel.css";

type PlexNode = { title: string; path: string | null };
type WalkPayload = {
  path: string;
  title: string;
  parents: PlexNode[];
  children: PlexNode[];
  friends: PlexNode[];
  challengers: PlexNode[];
};
type SearchItem = { title: string; path: string };

const DEFAULT_NOTE = "workspaces/functional-interface/plan.md";

function PlexNodeButton({
  node,
  onWalk,
  zone,
}: {
  node: PlexNode;
  onWalk: (path: string) => void;
  zone: string;
}) {
  return (
    <button
      className={`plex-node plex-${zone}${node.path ? "" : " plex-dangling"}`}
      title={node.path ?? "relation not resolved to a vault file"}
      onClick={() => node.path && onWalk(node.path)}
    >
      {node.title}
    </button>
  );
}

export function PlexPanel() {
  const [note, setNote] = useState<string | null>(null);
  const [walk, setWalk] = useState<WalkPayload | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [follow, setFollow] = useState(true);
  const [busy, setBusy] = useState(false);

  // deep link ?plex=<path>
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("plex");
    setNote(p || DEFAULT_NOTE);
  }, []);

  const load = useCallback(async (rel: string) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/plex?note=${encodeURIComponent(rel)}`);
      if (r.ok) {
        setWalk((await r.json()) as WalkPayload);
        setNote(rel);
        const url = new URL(window.location.href);
        url.searchParams.set("plex", rel);
        window.history.replaceState({}, "", url);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (note) void load(note);
  }, [note, load]);

  // search (debounced)
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/plex?q=${encodeURIComponent(query)}`);
      if (r.ok) {
        const d = (await r.json()) as { results: SearchItem[] };
        setResults(d.results);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const askHoney = useCallback(
    (w: WalkPayload) => {
      // Drive the app's own chat input — the same path a human takes, so
      // thread state, sending logic and rendering are all the app's own.
      const text =
        `I'm standing on the k-plex node "${w.title}" (${w.path}). ` +
        "Give me its story: what it is, where it sits (parents/children/friends), " +
        "and what you'd point me at next from here.";
      const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
        'textarea[placeholder*="Ask"], input[placeholder*="Ask"]',
      );
      if (!input) {
        console.error("plex ask: chat input not found");
        return;
      }
      const proto = input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      setTimeout(() => {
        input.focus();
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
          }),
        );
      }, 60);
    },
    [],
  );

  // Follow mode: when Honey's latest answer references a vault path, walk there.
  useEffect(() => {
    if (!follow) return;
    const paths = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="copilot-assistant-message"]'))
      .slice(-1)
      .flatMap((el) =>
        Array.from(el.textContent?.matchAll(/[\w-]+(?:\/[\w .-]+)+\.md/g) ?? [])
          .map((m) => m[0])
      );
    const target = paths.at(-1);
    if (target && target !== note) void load(target);
  });

  const zones = useMemo(
    () => [
      { key: "parents", label: "PARENTS · ABOVE", items: walk?.parents ?? [] },
      { key: "children", label: "CHILDREN · BELOW", items: walk?.children ?? [] },
    ],
    [walk],
  );

  return (
    <section className="dz plex-panel" aria-label="k-plex walk">
      <div className="plex-head">
        <b>k-plex</b>
        <label className="plex-follow" title="Walk to whatever vault path Honey's latest answer points at">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          follow Honey
        </label>
      </div>

      <input
        className="plex-search"
        placeholder="search the vault…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.length > 0 && (
        <div className="plex-results">
          {results.map((r) => (
            <button key={r.path} onClick={() => { setQuery(""); void load(r.path); }}>
              {r.title}
            </button>
          ))}
        </div>
      )}

      {walk && (
        <div className="plex-walk">
          <div className="plex-zone plex-up">
            <span className="plex-zone-label">{zones[0].label}</span>
            <div className="plex-node-row">
              {zones[0].items.length === 0 && <i className="plex-empty">none</i>}
              {zones[0].items.map((n, i) => (
                <PlexNodeButton key={i} node={n} onWalk={load} zone="parent" />
              ))}
            </div>
          </div>

          <div className="plex-mid">
            <div className="plex-zone plex-left">
              <span className="plex-zone-label">FRIENDS · LEFT</span>
              <div className="plex-node-col">
                {(walk.friends.length ? walk.friends : [{ title: "none", path: null }]).map((n, i) => (
                  <PlexNodeButton key={i} node={n} onWalk={load} zone="friend" />
                ))}
              </div>
            </div>
            <button className={`plex-center${busy ? " plex-busy" : ""}`} onClick={() => askHoney(walk)} title="Ask Honey about this node">
              <span className="plex-center-title">{walk.title}</span>
              <span className="plex-center-path">{walk.path}</span>
              <span className="plex-center-cta">💬 ask Honey about this</span>
            </button>
            <div className="plex-zone plex-right">
              <span className="plex-zone-label">CHALLENGERS · RIGHT</span>
              <div className="plex-node-col">
                {(walk.challengers?.length
                  ? walk.challengers
                  : [{ title: "none", path: null }]
                ).map((n, i) => (
                  <PlexNodeButton key={i} node={n} onWalk={load} zone="challenger" />
                ))}
              </div>
            </div>
          </div>

          <div className="plex-zone plex-down">
            <span className="plex-zone-label">{zones[1].label}</span>
            <div className="plex-node-row">
              {zones[1].items.length === 0 && <i className="plex-empty">none</i>}
              {zones[1].items.map((n, i) => (
                <PlexNodeButton key={i} node={n} onWalk={load} zone="child" />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
