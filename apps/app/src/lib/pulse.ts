import fs from "fs";
import path from "path";
import { parseFrontmatter, titleOf } from "@/lib/kanban";

// Platform pulse (THE REDO J07 — the k-plex dashboard's stage-04 content
// surfaced in the J01 viewer): the stage-02 C2 contract, unchanged —
// Daily/pulse/*.md is one typed event note per run, written by the seat
// that shipped it in the same commit (no pulse note = invisible run).
// Pure functions over file contents (same shape as lib/kanban) so the
// parse is unit-testable without disk fixtures. Read-only everywhere.

export type PulseEvent = {
  file: string;
  path: string; // vault-relative, for the reader click-through
  title: string;
  date: string;
  event: string;
  seat: string;
  project: string;
  receipt: string; // vault-relative path, tappable (may be empty)
  commit: string;
  body: string;
};

export const PULSE_LIMIT = 60;

// Newest-first by filename — the contract's files are date-prefixed
// (2026-10-09-<slug>.md), so the name IS the sort key. Parity with the
// stage-03 renderer (honeyui pulse_feed): the folder is the feed.
export function listPulseEvents(
  dir: string,
  { prefix, limit = PULSE_LIMIT }: { prefix: string; limit?: number },
): PulseEvent[] {
  const events: PulseEvent[] = [];
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return events;
  }
  for (const ent of [...files].sort((a, b) => (a.name < b.name ? 1 : -1))) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, ent.name), "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    // Body = everything after the closing fence — only when the note
    // actually opens one (a bare `---` rule in a fenceless note must
    // never slice the body).
    const hasFence = text.trimStart().startsWith("---");
    const close = hasFence ? text.indexOf("\n---", 3) : -1;
    const body = (close >= 0 ? text.slice(close + 4) : text).trim();
    events.push({
      file: ent.name,
      path: `${prefix}/${ent.name}`,
      title: fm.title || titleOf(text, ent.name.replace(/\.md$/, "")),
      date: fm.date || "",
      event: fm.event || "",
      seat: fm.seat || "",
      project: fm.project || "",
      receipt: fm.receipt || "",
      commit: fm.commit || "",
      body: body.slice(0, 500),
    });
    if (events.length >= limit) break;
  }
  return events;
}
