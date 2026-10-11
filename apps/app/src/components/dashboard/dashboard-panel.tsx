"use client";

import { useEffect, useState } from "react";
import { PlexPanel } from "@/components/kplex/plex-panel";

// k-plex sidebar — three outcomes, not a kanban wall (owner ruling
// 2026-10-11: the old board was no good; redesign for the sidebar form).
//   PULSE    status at a glance — counts + last vault movement
//   NEEDS ME unchecked OWNER-ACTIONS lines (the daily driver)
//   RUNS     history where every row opens its receipt (commit or card)
// Meta-Maps ride on top: the owner's navigation layer is first (2026-10-10).

type NeedItem = { text: string; kind: string; cardPath: string | null };
type RunItem = {
  id: string;
  when: string;
  what: string;
  kind: "commit" | "card";
  receipt: { type: "commit"; hash: string } | { type: "file"; path: string };
};
type MapItem = { path: string; title: string };

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

// The kind chip already carries the prefix; don't say REVIEW twice.
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

const LOOK_KEY = "kp-dash-last-look";

export function DashboardPanel() {
  const [board, setBoard] = useState<Board | null>(null);
  const [err, setErr] = useState("");
  const [fresh, setFresh] = useState<number | null>(null);

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
          // what moved since the last time this browser looked (outcome a)
          try {
            const prev = window.localStorage.getItem(LOOK_KEY);
            const n = prev
              ? d.runs.filter((r) => Date.parse(r.when) > Number(prev) && r.kind === "commit").length
              : null;
            setFresh(n && n > 0 ? n : n === null ? null : 0);
            window.localStorage.setItem(LOOK_KEY, String(Date.now()));
          } catch {
            setFresh(null);
          }
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
      <aside className="dash" aria-label="platform dashboard">
        <div className="dash-head">
          <span className="dash-dot dot-off" /> platform
        </div>
        <p className="dash-err">{err}</p>
      </aside>
    );
  if (!board)
    return (
      <aside className="dash" aria-label="platform dashboard">
        <div className="dash-head">
          <span className="dash-dot dot-off" /> platform
        </div>
        <p className="dash-dim">reading the vault…</p>
      </aside>
    );

  const p = board.pulse;

  return (
    <aside className="dash" aria-label="platform dashboard">
      <div className="dash-head">
        <span className={`dash-dot ${p.healthy ? "dot-ok" : "dot-off"}`} aria-hidden />
        <span className="dash-title">platform</span>
        <span className="dash-stamp">{board.generated?.slice(11, 16)}Z</span>
      </div>

      {/* Meta-Maps — the owner's navigation layer, first in every visual */}
      {board.metaMaps.length > 0 && (
        <nav className="dash-maps" aria-label="owner maps">
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
          <a className="pulse-cell p-need" href="#dash-needs">
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
        {fresh !== null && fresh > 0 && (
          <p className="pulse-fresh">
            +{fresh} run{fresh === 1 ? "" : "s"} since your last look
          </p>
        )}
      </section>

      {/* (b) what needs me */}
      <section className="dz" id="dash-needs" aria-label="what needs me">
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

      <p className="dash-dim dash-foot">live from the vault · no daemon · every run opens its receipt</p>
      <PlexPanel />
    </aside>
  );
}
