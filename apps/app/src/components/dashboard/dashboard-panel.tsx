"use client";

import { useEffect, useState } from "react";

type Board = {
  open: { text: string; kind: string }[];
  running: { slug: string; title: string; status: string; owner: string }[];
  waiting: { slug: string; title: string; status: string; owner: string }[];
  done: { slug: string; title: string; owner: string; when: string }[];
  generated?: string;
};

const kindLabel: Record<string, string> = { pick: "PICK", parked: "PARKED", action: "NEEDS YOU" };

export function DashboardPanel() {
  const [board, setBoard] = useState<Board | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/board", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => { if (alive) { d.error ? setErr(d.error) : setBoard(d); } })
        .catch((e) => { if (alive) setErr(String(e).slice(0, 80)); });
    load();
    const t = setInterval(load, 20000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (err) return <aside className="dash"><h3>dashboard</h3><p className="dash-err">{err}</p></aside>;
  if (!board) return <aside className="dash"><h3>dashboard</h3><p className="dash-dim">reading the vault…</p></aside>;

  return (
    <aside className="dash" aria-label="platform dashboard">
      <h3>OPEN — needs you <span className="dash-count">{board.open.length}</span></h3>
      <div className="dash-list">
        {board.open.length === 0 && <p className="dash-dim">nothing needs you</p>}
        {board.open.map((a, i) => (
          <div key={i} className={`dash-item k-${a.kind}`}>
            <span className="dash-kind">{kindLabel[a.kind] || ""}</span>
            <span className="dash-text">{a.text}</span>
          </div>
        ))}
      </div>

      <h3>RUNNING — agents <span className="dash-count">{board.running.length}</span></h3>
      <div className="dash-list">
        {board.running.length === 0 && <p className="dash-dim">idle</p>}
        {board.running.map((c) => (
          <div key={c.slug} className="dash-item k-run">
            <span className="dash-kind">{c.status}</span>
            <span className="dash-text">{c.title} <span className="dash-dim">· {c.owner}</span></span>
          </div>
        ))}
      </div>

      {board.waiting.length > 0 && (
        <>
          <h3>AT GATES <span className="dash-count">{board.waiting.length}</span></h3>
          <div className="dash-list">
            {board.waiting.map((c) => (
              <div key={c.slug} className="dash-item k-wait">
                <span className="dash-kind">{c.status}</span>
                <span className="dash-text">{c.title} <span className="dash-dim">· {c.owner}</span></span>
              </div>
            ))}
          </div>
        </>
      )}

      <h3>DONE — last 2 weeks <span className="dash-count">{board.done.length}</span></h3>
      <div className="dash-list">
        {board.done.length === 0 && <p className="dash-dim">nothing finished yet</p>}
        {board.done.map((c) => (
          <div key={c.slug} className="dash-item k-done">
            <span className="dash-kind">{c.when}</span>
            <span className="dash-text">{c.title} <span className="dash-dim">· {c.owner}</span></span>
          </div>
        ))}
      </div>
      <p className="dash-dim dash-stamp">live from the vault · {board.generated?.slice(11, 16)}Z</p>
    </aside>
  );
}
