"use client";

import { useEffect, useState } from "react";
import { doorUrl } from "@/lib/vault-links";
import "./cockpit.css";

// Boards tab — the MWP vault kanban, mirrored (owner directive
// 2026-10-12: "the board is like the Kanban on MWP vault"). Columns are
// the statuses from kanban/STATUSES.md, cards are kanban/*.md
// (title/status/tags), every card clicks through the vault door.
// The board's older instruments stay, demoted below the columns: the
// pulse strip, OWNER-ACTIONS needs, and run history with receipts —
// same /api/board read (a pure vault read, no daemon).

type NeedItem = { text: string; kind: string; cardPath: string | null };
type RunItem = {
  id: string;
  when: string;
  what: string;
  kind: "commit" | "card";
  receipt: { type: "commit"; hash: string } | { type: "file"; path: string };
};
type MapItem = { path: string; title: string };
type KanbanColumn = { key: string; note: string };
type KanbanCard = {
  file: string;
  path: string;
  title: string;
  status: string;
  owner: string | null;
  tags: string[];
  updated: string;
};

type Board = {
  pulse: {
    needsYou: number;
    inFlight: number;
    atGates: number;
    runs24h: number;
    lastMovement: { when: string; what: string; hash: string } | null;
    healthy: boolean;
  };
  metaMaps: MapItem[];
  needs: NeedItem[];
  runs: RunItem[];
  kanban: { columns: KanbanColumn[]; cards: KanbanCard[] };
  generated?: string;
};

const kindLabel: Record<string, string> = {
  pick: "PICK",
  parked: "PARKED",
  review: "REVIEW",
  action: "NEEDS YOU",
};

const receiptUrl = (r: RunItem["receipt"]) =>
  r.type === "commit"
    ? `/api/board/receipt?commit=${r.hash}`
    : `/api/board/receipt?file=${encodeURIComponent(r.path)}`;

const fileUrl = (p: string) => `/api/board/receipt?file=${encodeURIComponent(p)}`;

const displayText = (a: NeedItem): string =>
  a.kind === "review" || a.kind === "pick"
    ? a.text.replace(/^(REVIEW|DECIDE|PICK)[:\s—-]*/i, "").trim() || a.text
    : a.text;

function rel(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function BoardsView() {
  const [board, setBoard] = useState<Board | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/board", { cache: "no-store" })
        .then((r) => r.json())
        .then((d: Board & { error?: string }) => {
          if (!alive) return;
          if (d.error) {
            setErr(d.error);
            return;
          }
          setErr("");
          setBoard(d);
        })
        .catch((e: unknown) => {
          if (alive) setErr(String(e).slice(0, 80));
        });
    load();
    const t = setInterval(load, 20000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (err)
    return (
      <div className="cockpit-board">
        <p className="dash-err">{err}</p>
      </div>
    );
  if (!board)
    return (
      <div className="cockpit-board">
        <p className="dash-dim">reading the vault…</p>
      </div>
    );

  const p = board.pulse;

  return (
    <div className="cockpit-board">
      <div className="dash-head" style={{ padding: 0 }}>
        <span className={`dash-dot ${p.healthy ? "dot-ok" : "dot-off"}`} aria-hidden />
        <span className="dash-title">platform</span>
        <span className="dash-stamp">{board.generated?.slice(11, 16)}Z</span>
      </div>

      {/* Meta-Maps — the owner's navigation layer, first in every visual */}
      {board.metaMaps.length > 0 && (
        <nav className="cockpit-links" aria-label="owner maps">
          <span className="dz-tag">maps</span>
          {board.metaMaps.map((m) => (
            <a key={m.path} href={fileUrl(m.path)} target="_blank" rel="noopener" title={m.path}>
              {m.title}
            </a>
          ))}
        </nav>
      )}

      {/* (a) status at a glance */}
      <section className="dz" aria-label="status at a glance">
        <div className="pulse-grid">
          <a className="pulse-cell p-need" href="#board-needs">
            <b>{p.needsYou}</b>
            <i>needs you</i>
          </a>
          <div className="pulse-cell">
            <b>{p.inFlight}</b>
            <i>in flight</i>
          </div>
          <div className={`pulse-cell${p.atGates > 0 ? " p-gate" : ""}`}>
            <b>{p.atGates}</b>
            <i>at gates</i>
          </div>
          <div className="pulse-cell">
            <b>{p.runs24h}</b>
            <i>runs 24h</i>
          </div>
        </div>
        {p.lastMovement && (
          <a
            className="pulse-last"
            href={`/api/board/receipt?commit=${p.lastMovement.hash}`}
            target="_blank"
            rel="noopener"
            title={p.lastMovement.hash}
          >
            moved {rel(p.lastMovement.when)} ago — {p.lastMovement.what} <span className="rarrow">↗</span>
          </a>
        )}
      </section>

      {/* the kanban itself — columns = STATUSES.md, cards = kanban/*.md,
          click-through = the vault door */}
      <section className="dz kanban-mirror" aria-label="MWP kanban mirror">
        <h3>
          MWP kanban <span className="dash-count">{board.kanban.cards.length}</span>
        </h3>
        <div className="kanban-columns">
          {board.kanban.columns.map((col) => {
            const cards = board.kanban.cards.filter((c) => c.status === col.key);
            return (
              <div key={col.key} className="kanban-col" data-status={col.key}>
                <h4 title={col.note}>
                  {col.key} <span className="dash-count">{cards.length}</span>
                </h4>
                <div className="kanban-cards">
                  {cards.length === 0 && <i className="plex-empty">none</i>}
                  {cards.map((c) => (
                    <a
                      key={c.path}
                      className="kanban-card"
                      href={doorUrl(c.path)}
                      target="_blank"
                      rel="noopener"
                      title={`${c.path}${c.owner ? ` · ${c.owner}` : ""}`}
                    >
                      <span className="kanban-card-title">{c.title}</span>
                      {(c.owner || c.tags.length > 0) && (
                        <span className="kanban-card-meta">
                          {c.owner && <span className="kanban-owner">{c.owner}</span>}
                          {c.tags.slice(0, 3).map((t) => (
                            <span key={t} className="kanban-tag">
                              {t}
                            </span>
                          ))}
                        </span>
                      )}
                    </a>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <p className="dash-dim kanban-hint">
          cards open in the vault door — moving a card stays in the vault (edit its
          <code> status:</code>, commit); this mirror is read-only.
        </p>
      </section>

      <div className="cockpit-board-cols">
        {/* (b) what needs me */}
        <section className="dz" id="board-needs" aria-label="what needs me">
          <h3>
            what needs me <span className="dash-count">{board.needs.length}</span>
          </h3>
          <div className="dash-list">
            {board.needs.length === 0 && <p className="dash-dim">nothing needs you</p>}
            {board.needs.map((a, i) => (
              <a
                key={i}
                className={`dash-item k-${a.kind}`}
                href={fileUrl(a.cardPath || "kanban/OWNER-ACTIONS.md")}
                target="_blank"
                rel="noopener"
                title={a.cardPath || "kanban/OWNER-ACTIONS.md"}
              >
                <span className="dash-kind">{kindLabel[a.kind] || "NEEDS YOU"}</span>
                <span className="dash-text">{displayText(a)}</span>
              </a>
            ))}
          </div>
        </section>

        {/* (c) run history with receipts — every row opens the real thing */}
        <section className="dz" aria-label="run history">
          <h3>
            runs <span className="dash-count">{board.runs.length}</span>
          </h3>
          <div className="dash-list">
            {board.runs.length === 0 && <p className="dash-dim">no runs recorded yet</p>}
            {board.runs.map((r) => (
              <a
                key={r.id}
                className="run-row"
                href={receiptUrl(r.receipt)}
                target="_blank"
                rel="noopener"
                title={r.receipt.type === "commit" ? `commit ${r.receipt.hash}` : r.receipt.path}
              >
                <time className="run-when">{rel(r.when)}</time>
                <span className="run-what">{r.what}</span>
                <span className="run-proof">
                  {r.receipt.type === "commit" ? `${r.receipt.hash.slice(0, 7)} ↗` : "card ↗"}
                </span>
              </a>
            ))}
          </div>
        </section>
      </div>

      <p className="dash-dim">live from the vault · no daemon · every run opens its receipt</p>
    </div>
  );
}
