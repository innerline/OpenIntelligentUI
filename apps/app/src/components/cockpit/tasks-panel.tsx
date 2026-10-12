"use client";

import { useEffect, useState } from "react";
import { doorUrl, receiptUrl } from "@/lib/vault-links";
import "./cockpit.css";

// Tasks panel embedded in each chat surface (owner directive 2026-10-12:
// the standalone Tasks tab goes away, each chat gets its own tasks).
// Two REAL sources, one component:
//   - honey: /api/board's kanban mirror — the MWP vault kanban. Cards
//     click through the vault door (http://…:8135/?file=kanban/<slug>).
//   - larry: /api/larry-tasks — the Personal vault myPKA task system
//     (Larry ≠ Honey: his board, his vault, read-only). Cards open via
//     the app's receipt route scoped to the Personal vault.
// Collapsed by default it is one slim bar with live counts; expanded it
// is a horizontally scrolling mini-board. Polling lives INSIDE this
// component (local state only) so it never re-renders the chat above it.

type Column = { key: string; note?: string };
type Card = {
  file: string;
  path: string;
  title: string;
  status: string;
  owner: string | null;
  tags: string[];
  updated: string;
};
type Payload = { columns: Column[]; cards: Card[]; note?: string; error?: string };

const CONFIG = {
  honey: {
    endpoint: "/api/board",
    heading: "tasks — MWP kanban",
    source: "vault · read-only",
    link: (c: Card) => doorUrl(c.path),
  },
  larry: {
    endpoint: "/api/larry-tasks",
    heading: "tasks — Larry's board",
    source: "Personal vault · myPKA · read-only",
    link: (c: Card) => receiptUrl(c.path, "personal"),
  },
} as const;

function rel(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return "now";
  if (s < 86400) return `${Math.floor(s / 60 / 60)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function TasksPanel({ source }: { source: keyof typeof CONFIG }) {
  const cfg = CONFIG[source];
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(cfg.endpoint, { cache: "no-store" })
        .then((r) => r.json())
        .then((d: Payload) => {
          if (!alive) return;
          if (d.error) {
            setErr(d.error);
            return;
          }
          setErr("");
          setData(d);
        })
        .catch((e: unknown) => {
          if (alive) setErr(String(e).slice(0, 80));
        });
    load();
    const t = setInterval(load, 45000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [cfg.endpoint]);

  const columns = data?.columns ?? [];
  const cards = data?.cards ?? [];
  const openCount = cards.filter((c) => c.status !== "done" && c.status !== "cancelled").length;

  return (
    <section className="cockpit-tasks-panel" aria-label={`${cfg.heading}`}>
      <button
        className="tasks-panel-bar"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? "Collapse the tasks panel" : "Expand the tasks panel"}
      >
        <span className="tasks-panel-caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="tasks-panel-heading">{cfg.heading}</span>
        {data && (
          <span className="tasks-panel-count">
            {openCount} open · {cards.length} cards
          </span>
        )}
        {err && <span className="tasks-panel-err">{err}</span>}
        <span className="tasks-panel-source">{cfg.source}</span>
      </button>
      {open && (
        <div className="tasks-panel-board">
          {columns.map((col) => {
            const inCol = cards.filter((c) => c.status === col.key);
            return (
              <div key={col.key} className="tasks-panel-col" data-status={col.key}>
                <h4>
                  {col.key} <span className="dash-count">{inCol.length}</span>
                </h4>
                {inCol.length === 0 && <i className="plex-empty">none</i>}
                {inCol.map((c) => (
                  <a
                    key={c.path}
                    className="tasks-panel-card"
                    href={cfg.link(c)}
                    target="_blank"
                    rel="noopener"
                    title={c.path}
                  >
                    <span className="tasks-panel-card-title">{c.title}</span>
                    <span className="tasks-panel-card-meta">
                      {c.owner ? `${c.owner} · ` : ""}
                      {rel(c.updated)}
                    </span>
                  </a>
                ))}
              </div>
            );
          })}
          {columns.length === 0 && !err && (
            <p className="dash-dim tasks-panel-dim">
              reading {source === "honey" ? "the MWP vault kanban" : "the Personal vault task system"}…
            </p>
          )}
          {data && columns.length > 0 && cards.length === 0 && (
            <p className="dash-dim tasks-panel-dim">
              no cards found — nothing faked; {cfg.source}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
