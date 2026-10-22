import fs from "fs";
import path from "path";

// Kanban parsing — shared by /api/board (MWP vault mirror) and
// /api/larry-tasks (Personal vault myPKA). Pure functions over file
// contents so the parsing is unit-testable without disk fixtures.
// Read-only everywhere: cards are moved by editing them in the vault,
// never through this app.

export type KanbanColumn = { key: string; note: string };

export type KanbanCard = {
  file: string;
  path: string; // vault-relative, for door/receipt links
  title: string;
  status: string;
  owner: string | null;
  tags: string[];
  updated: string; // ISO — file mtime
};

// Tolerant frontmatter reader. Handles `---` fences, `# section`
// comment lines inside the fence (Personal vault task files use them),
// and quoted values. Returns {} when there is no frontmatter.
export function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return {};
  const fm: Record<string, string> = {};
  for (const ln of lines.slice(1, 60)) {
    const t = ln.trim();
    if (t === "---") break;
    if (t.startsWith("#")) continue; // section comments, not keys
    const m = t.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (m) fm[m[1]] = stripValue(m[2]);
  }
  return fm;
}

export function stripValue(v: string): string {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    return s.slice(1, -1).trim();
  return s;
}

export function parseTags(v: string | undefined): string[] {
  if (!v) return [];
  const inner = v.replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((t) => stripValue(t))
    .filter(Boolean);
}

export function titleOf(text: string, fallback: string): string {
  const h1 = text.split("\n").find((l) => l.startsWith("# "));
  const t = h1?.slice(2).trim();
  return t || fallback;
}

// Columns from MWP kanban/STATUSES.md — the table rows like
// `| `running` | claimed, work in progress | the working agent |`.
export function parseStatusVocabulary(statusesMd: string): KanbanColumn[] {
  const cols: KanbanColumn[] = [];
  for (const ln of statusesMd.split("\n")) {
    const m = ln.match(/^\|\s*`([a-z-]+)`\s*\|([^|]+)\|/);
    if (m) cols.push({ key: m[1], note: m[2].trim() });
  }
  return cols;
}

// Cards from a flat kanban dir (MWP `kanban/`, Personal `Kanban/`).
// A file is a card only when its frontmatter carries a status that is
// in the vocabulary — this excludes view/system files (STATUSES.md,
// OWNER-ACTIONS.md, auto-generated HONEY_QUEUE.md, PROTOCOL.md …)
// without hardcoding names.
export function listKanbanCards(
  dir: string,
  vocabulary: Set<string>,
  { prefix }: { prefix: string },
): KanbanCard[] {
  const cards: KanbanCard[] = [];
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return cards;
  }
  for (const ent of files) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    const full = path.join(dir, ent.name);
    let text = "";
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    const status = fm.status || "";
    if (!vocabulary.has(status)) continue;
    cards.push({
      file: ent.name,
      path: `${prefix}/${ent.name}`,
      title: fm.title || titleOf(text, ent.name.replace(/\.md$/, "")),
      status,
      owner: fm.owner || null,
      tags: parseTags(fm.tags),
      updated: new Date(fs.statSync(full).mtimeMs).toISOString(),
    });
  }
  return cards.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
}

// --- cockpit sidebar board (kanban-restructure S3, 2026-10-22) ---
//
// The sidebar board shows the CURRENT kanban: unfinished cards only —
// done/cancelled are finished and leave it (they ride kanban/archive/
// after the 30-day law). A card qualifies by carrying a status that
// READS like one — a single lowercase word, the shared vocabulary's
// shape — which keeps generated views out (HONEY_QUEUE.md carries a
// whole sentence in `status:`) without hardcoding filenames. Statuses
// beyond the STATUSES.md vocabulary (`doing`, `blocked` — real cards on
// today's board) are kept, grouped after the vocabulary columns: never
// dropped, never relabeled — the sidebar shows what IS.

// Statuses that mean the work is finished — off the current board.
export const FINISHED_STATUSES = new Set(["done", "cancelled"]);

export type BoardGroup = { status: string; note: string; cards: KanbanCard[] };

const STATUS_WORD = /^[a-z][a-z-]*$/;

export function isUnfinishedStatus(status: string): boolean {
  return STATUS_WORD.test(status) && !FINISHED_STATUSES.has(status);
}

// Flat walk of a kanban dir — TOP-LEVEL .md files only, so
// kanban/archive/** never appears (archived cards live in subfolders).
// Same walk shape and KanbanCard mapping as listKanbanCards, but gated
// on isUnfinishedStatus instead of the vocabulary: off-vocabulary
// statuses stay on the board.
export function listUnfinishedKanbanCards(
  dir: string,
  { prefix }: { prefix: string },
): KanbanCard[] {
  const cards: KanbanCard[] = [];
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return cards;
  }
  for (const ent of files) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    const full = path.join(dir, ent.name);
    let text = "";
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    if (!isUnfinishedStatus(fm.status || "")) continue;
    cards.push({
      file: ent.name,
      path: `${prefix}/${ent.name}`,
      title: fm.title || titleOf(text, ent.name.replace(/\.md$/, "")),
      status: fm.status,
      owner: fm.owner || null,
      tags: parseTags(fm.tags),
      updated: new Date(fs.statSync(full).mtimeMs).toISOString(),
    });
  }
  return cards.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
}

const byUpdatedDesc = (a: KanbanCard, b: KanbanCard) =>
  Date.parse(b.updated) - Date.parse(a.updated);

// Group cards for compact sidebar display: the STATUSES.md columns
// first, in vocabulary order (finished columns skipped), then any
// on-card statuses the vocabulary doesn't cover, alphabetical — the
// board is what the cards say, not what the table says. Empty groups
// are skipped; cards within a group sort newest-first.
export function groupBoardCards(
  columns: KanbanColumn[],
  cards: KanbanCard[],
): BoardGroup[] {
  const byStatus = new Map<string, KanbanCard[]>();
  for (const c of cards) {
    // defensive: finished cards never board the sidebar, even if a
    // caller passes an unfiltered list
    if (FINISHED_STATUSES.has(c.status)) continue;
    const list = byStatus.get(c.status);
    if (list) list.push(c);
    else byStatus.set(c.status, [c]);
  }
  const groups: BoardGroup[] = [];
  const covered = new Set<string>();
  for (const col of columns) {
    if (FINISHED_STATUSES.has(col.key)) continue;
    covered.add(col.key);
    const list = byStatus.get(col.key);
    if (list?.length) groups.push({ status: col.key, note: col.note, cards: [...list].sort(byUpdatedDesc) });
  }
  for (const s of [...byStatus.keys()].filter((s) => !covered.has(s)).sort()) {
    groups.push({ status: s, note: "", cards: [...byStatus.get(s)!].sort(byUpdatedDesc) });
  }
  return groups;
}

// Larry's myPKA task files (Personal vault `Team Knowledge/tasks/`).
// Lifecycle is the folder (protocol table in Personal Kanban/PROTOCOL.md):
// open/ → triage, in-progress/ → active (waiting when blocked_reason is
// set), done/YYYY/MM/ → done, cancelled/… → cancelled.
export function listMyPkaTasks(
  root: string,
  { prefix }: { prefix: string },
): KanbanCard[] {
  const cards: KanbanCard[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(full, r);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
      const segs = r.split("/");
      const lifecycle = segs[0];
      let text = "";
      try {
        text = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const fm = parseFrontmatter(text);
      let status: string | null = null;
      if (lifecycle === "open") status = "triage";
      else if (lifecycle === "in-progress")
        status = fm.blocked_reason && fm.blocked_reason !== "null" ? "waiting" : "active";
      else if (lifecycle === "done") status = "done";
      else if (lifecycle === "cancelled") status = "cancelled";
      if (!status) continue;
      cards.push({
        file: ent.name,
        path: `${prefix}/${r}`,
        title: fm.title || titleOf(text, ent.name.replace(/\.md$/, "")),
        status,
        owner: fm.assignee || null,
        tags: parseTags(fm.tags),
        updated: new Date(fs.statSync(full).mtimeMs).toISOString(),
      });
    }
  };
  walk(root, "");
  return cards.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
}
