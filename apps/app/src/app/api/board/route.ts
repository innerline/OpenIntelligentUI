import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { listKanbanCards, parseStatusVocabulary } from "@/lib/kanban";
import type { KanbanCard, KanbanColumn } from "@/lib/kanban";

// k-plex sidebar dashboard data — a pure read of the MWP vault.
// Three outcomes (spec: copilot/projects/k-plex project/stage-01-dashboard-spec.md):
//   (a) status at a glance  -> pulse (counts + last vault movement)
//   (b) what needs me       -> unchecked OWNER-ACTIONS lines under LIVE BLOCKS
//   (c) run history w/ receipts -> vault commits + done cards, every row linked
// Plus the Meta-Maps entry layer (owner ruling 2026-10-10: first in every visual)
// and, since the 2026-10-12 cockpit redesign, the full kanban mirror (columns =
// kanban/STATUSES.md vocabulary, cards = kanban/*.md) that the Boards tab and
// Honey's tasks panel render.

export const dynamic = "force-dynamic";

const VAULT = process.env.MWP_VAULT || "/Users/silverhawk/GitHub/MWP";

export type NeedItem = { text: string; kind: string; cardPath: string | null };
export type RunItem = {
  id: string;
  when: string; // ISO
  what: string;
  kind: "commit" | "card";
  receipt: { type: "commit"; hash: string } | { type: "file"; path: string };
};
export type MapItem = { path: string; title: string };

export type BoardPayload = {
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
  generated: string;
};

function gitLog(max: number): { hash: string; when: string; subject: string }[] {
  try {
    const out = execFileSync(
      "git",
      ["-C", VAULT, "log", "-n", String(max), "--format=%H|%cI|%s"],
      { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 512 },
    );
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((ln) => {
        const [hash, when, ...rest] = ln.split("|");
        return { hash, when, subject: rest.join("|").trim() };
      })
      .filter((c) => c.hash && c.when);
  } catch {
    return [];
  }
}

// 30-min mirror syncs are platform heartbeat, not substantial runs — the runs
// list is for "what actually happened", so they stay out of it (R2 substance).
const CHURN = /^(memory: sync|autowiki: self-publish)/i;

function kindOf(t: string): string {
  if (t.includes("PICK:") || t.startsWith("PICK")) return "pick";
  if (t.startsWith("(PARKED") || t.startsWith("(OPTIONAL")) return "parked";
  if (t.startsWith("REVIEW") || t.startsWith("DECIDE")) return "review";
  return "action";
}

function cardPathIn(t: string): string | null {
  const m = t.match(/(?:kanban|seats|workspaces|knowledge|copilot)\/[\w./-]+\.md/i);
  return m ? m[0] : null;
}

export async function GET() {
  try {
    const now = Date.now();
    const day = 864e5;

    // (b) what needs me — unchecked lines under LIVE BLOCKS in OWNER-ACTIONS
    const needs: NeedItem[] = [];
    try {
      const oa = fs.readFileSync(path.join(VAULT, "kanban/OWNER-ACTIONS.md"), "utf8");
      let live = false;
      for (const ln of oa.split("\n")) {
        if (ln.startsWith("# ")) {
          live = ln.includes("LIVE BLOCKS");
          continue;
        }
        if (!live || !ln.trim().startsWith("- [ ]")) continue;
        const t = ln.split("- [ ]")[1]?.trim();
        if (!t) continue;
        needs.push({ text: t.slice(0, 220), kind: kindOf(t), cardPath: cardPathIn(t) });
      }
    } catch {}

    // kanban mirror — columns from STATUSES.md, cards = files whose
    // frontmatter status is in that vocabulary (excludes views/system
    // files like HONEY_QUEUE.md without hardcoding names). The pulse
    // counts derive from the same list.
    const columns: KanbanColumn[] = (() => {
      try {
        return parseStatusVocabulary(
          fs.readFileSync(path.join(VAULT, "kanban/STATUSES.md"), "utf8"),
        );
      } catch {
        return [];
      }
    })();
    const vocabulary = new Set(columns.map((c) => c.key));
    const cards = listKanbanCards(path.join(VAULT, "kanban"), vocabulary, {
      prefix: "kanban",
    });

    let inFlight = 0;
    let atGates = 0;
    let done7d = 0;
    const doneCards: RunItem[] = [];
    const dir = path.join(VAULT, "kanban");
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {}
    for (const c of cards) {
      const age = now - Date.parse(c.updated);
      if (c.status === "running" || c.status === "ready") inFlight++;
      else if (c.status === "block" || c.status === "review") atGates++;
      else if (c.status === "done") {
        if (age < 7 * day) done7d++;
        if (age < 14 * day)
          doneCards.push({
            id: `card:${c.file}`,
            when: c.updated,
            what: c.title.slice(0, 90),
            kind: "card",
            receipt: { type: "file", path: c.path },
          });
      }
    }

    // (c) run history — vault commits are the receipted event stream
    const log = gitLog(120);
    const substantial = log.filter((c) => !CHURN.test(c.subject));
    const commits24h = substantial.filter((c) => now - Date.parse(c.when) < day).length;
    const commitRuns: RunItem[] = substantial.slice(0, 20).map((c) => ({
      id: `commit:${c.hash}`,
      when: c.when,
      what: c.subject.slice(0, 110),
      kind: "commit",
      receipt: { type: "commit", hash: c.hash },
    }));

    const runs = [...commitRuns, ...doneCards]
      .sort((a, b) => Date.parse(b.when) - Date.parse(a.when))
      .slice(0, 18);

    // Meta-Maps entry layer — owner navigation, first in every visual
    const metaMaps: MapItem[] = [];
    try {
      const mdir = path.join(VAULT, "Meta-Maps");
      for (const f of fs
        .readdirSync(mdir)
        .filter((f) => /\.(md|canvas)$/i.test(f))
        .sort())
        metaMaps.push({ path: `Meta-Maps/${f}`, title: f.replace(/\.(md|canvas)$/i, "") });
    } catch {}

    const last = substantial[0] ?? log[0] ?? null;
    const payload: BoardPayload = {
      pulse: {
        needsYou: needs.length,
        inFlight,
        atGates,
        runs24h: commits24h || done7d,
        lastMovement: last ? { when: last.when, what: last.subject.slice(0, 80), hash: last.hash } : null,
        healthy: log.length > 0 || files.length > 0,
      },
      metaMaps,
      needs,
      runs,
      kanban: { columns, cards },
      generated: new Date().toISOString(),
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
