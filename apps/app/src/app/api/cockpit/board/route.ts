import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  groupBoardCards,
  listUnfinishedKanbanCards,
  parseStatusVocabulary,
} from "@/lib/kanban";
import type { BoardGroup } from "@/lib/kanban";

// Cockpit board lane (kanban-restructure S3, owner directive
// 2026-10-22): the CURRENT MWP kanban for the right sidebar — the
// unfinished cards grouped by status (vocabulary columns first, then
// any on-card statuses STATUSES.md doesn't cover), newest-first within
// a group. A pure read of the vault server-side, same location pattern
// as the other cockpit routes (/api/board's MWP_VAULT); the walk is
// top-level files only, so kanban/archive/** never appears. Read-only:
// cards move by editing the vault, never through this app.

export const dynamic = "force-dynamic";

function vaultDir(): string {
  return process.env.MWP_VAULT || "/Users/silverhawk/GitHub/MWP";
}

export type CockpitBoardPayload = {
  groups: BoardGroup[];
  generated: string;
};

export async function GET() {
  try {
    const dir = path.join(vaultDir(), "kanban");
    // Unreadable vault -> 503, so the sidebar says "unreadable" instead
    // of "nothing unfinished" (a clear board and a missing vault must
    // never look the same).
    if (!fs.existsSync(dir)) {
      return NextResponse.json(
        { error: "kanban dir not found" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const columns = (() => {
      try {
        return parseStatusVocabulary(
          fs.readFileSync(path.join(dir, "STATUSES.md"), "utf8"),
        );
      } catch {
        return []; // unreadable vocabulary — cards still group by status
      }
    })();
    const cards = listUnfinishedKanbanCards(dir, {
      prefix: "kanban",
    });
    const payload: CockpitBoardPayload = {
      groups: groupBoardCards(columns, cards),
      generated: new Date().toISOString(),
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
