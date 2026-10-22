"use client";

import { useEffect, useState } from "react";
import { honeyuiFileUrl } from "@/lib/honeyui-proxy";
import type { BoardGroup } from "@/lib/kanban";
import "./cockpit.css";

// The board section of the visuals sidebar (kanban-restructure S3,
// owner directive 2026-10-22): the CURRENT kanban — unfinished cards
// grouped by status — beside the chat on every device. Read-only by the
// sidebar law: the one interaction is the click-through, opening the
// card itself through the cockpit's honeyui file proxy (the keyed
// reader, token inlined server-side) in a new tab. Light auto-refresh:
// a 60s poll plus a refetch when the tab becomes visible again.

type Payload = { groups: BoardGroup[]; generated: string };

const REFRESH_MS = 60_000;

export function BoardPanel() {
  const [groups, setGroups] = useState<BoardGroup[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/cockpit/board", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((p: Payload) => {
          if (!cancelled) {
            setGroups(p.groups ?? []);
            setError("");
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        });
    };
    load();
    const iv = setInterval(load, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const total = groups?.reduce((n, g) => n + g.cards.length, 0) ?? 0;

  return (
    <section className="sidebar-board" aria-label="the current kanban board">
      <div className="sidebar-board-head">
        <b>board · kanban</b>
        {groups !== null && <span className="board-count">{total} unfinished</span>}
      </div>
      {groups === null && !error && (
        <p className="board-hint">reading the vault board…</p>
      )}
      {error && <p className="board-hint board-error">board unreadable ({error})</p>}
      {groups?.length === 0 && (
        <p className="board-hint">nothing unfinished — the board is clear.</p>
      )}
      {groups?.map((g) => (
        <div key={g.status} className="board-group" data-status={g.status}>
          <span className="board-status" title={g.note || g.status}>
            {g.status} <b>{g.cards.length}</b>
          </span>
          <ul>
            {g.cards.map((c) => (
              <li key={c.file}>
                <a href={honeyuiFileUrl(c.path)} target="_blank" rel="noopener" title={c.path}>
                  <span className="board-card-title">{c.title}</span>
                  {c.owner && <i className="board-owner">{c.owner}</i>}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
