import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { listKanbanCards, listMyPkaTasks } from "@/lib/kanban";
import type { KanbanCard, KanbanColumn } from "@/lib/kanban";

// Larry's tasks — a pure read of the PERSONAL vault's myPKA task system.
// Larry ≠ Honey (owner ruling, weeks standing): his board is not the MWP
// kanban. Sources, per Personal `Kanban/PROTOCOL.md`:
//   - `Team Knowledge/tasks/` — the SSOT task files; lifecycle is the
//     folder (open → triage, in-progress → active, blocked → waiting,
//     done → done, cancelled → cancelled).
//   - `Kanban/Cards/` — the visual board cards (`status:` frontmatter).
//   - `Kanban/*.md` root — retired/finished cards still carrying a status.
// Read-only: single-user tailnet app serving the owner his own data.
// Cards are moved in Obsidian, never through this app.

export const dynamic = "force-dynamic";

const PERSONAL =
  process.env.PERSONAL_VAULT ||
  "/Users/silverhawk/Library/Mobile Documents/iCloud~md~obsidian/Documents/Personal";

// Larry's board vocabulary (PROTOCOL.md mapping) — `block` on a root card
// means "awaiting a Brian gate", which renders in his `waiting` column.
const LARRY_COLUMNS: KanbanColumn[] = [
  { key: "triage", note: "raw idea — needs fleshing into a real task" },
  { key: "active", note: "claimed, work in progress" },
  { key: "waiting", note: "waiting for Brian — a review gate" },
  { key: "done", note: "closed" },
  { key: "cancelled", note: "voided, never counted as done" },
];

const LARRY_VOCAB = new Set(LARRY_COLUMNS.map((c) => c.key));
// `block` appears on root Kanban cards ("awaiting a Brian gate") — read it,
// then normalize it into Larry's `waiting` column.
const READ_VOCAB = new Set([...LARRY_VOCAB, "block"]);

function normalizeStatus(s: string): string {
  if (s === "block") return "waiting"; // awaiting a Brian gate (PROTOCOL.md)
  return LARRY_VOCAB.has(s) ? s : "";
}

export async function GET() {
  try {
    if (!fs.existsSync(PERSONAL)) {
      return NextResponse.json(
        {
          columns: LARRY_COLUMNS,
          cards: [],
          note: "Personal vault not found on this host — nothing faked.",
          generated: new Date().toISOString(),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const cards: KanbanCard[] = [];
    cards.push(...listMyPkaTasks(path.join(PERSONAL, "Team Knowledge/tasks"), {
      prefix: "Team Knowledge/tasks",
    }));
    cards.push(
      ...listKanbanCards(path.join(PERSONAL, "Kanban/Cards"), READ_VOCAB, {
        prefix: "Kanban/Cards",
      }),
    );
    cards.push(
      ...listKanbanCards(path.join(PERSONAL, "Kanban"), READ_VOCAB, {
        prefix: "Kanban",
      }),
    );

    const normalized = cards
      .map((c) => ({ ...c, status: normalizeStatus(c.status) }))
      .filter((c) => c.status)
      // one card can appear twice (task file + its board card) — the board
      // card wins visually; dedupe on title
      .filter((c, i, all) => all.findIndex((o) => o.title === c.title) === i)
      .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));

    return NextResponse.json(
      {
        columns: LARRY_COLUMNS,
        cards: normalized,
        note: "Personal vault · myPKA task system (read-only)",
        generated: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
