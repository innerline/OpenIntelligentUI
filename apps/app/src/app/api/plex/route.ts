import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// k-plex walk API — the plex grammar (parents above · note center ·
// children below · friends left) rendered OUTSIDE Obsidian, in the
// Intelligence UI. Owner direction 2026-10-11: "k-plex can run outside of
// obsidian"; "agent can create visuals with their text … in k-plex format,
// I can engage it in k-plex."
//
// A pure read of the MWP vault, ported from the proven :8135 machinery
// (agentic-stack honeyui/server.py plex_note — browser-verified live
// 2026-10-11). No daemon, no store: runs only when the panel asks.
//
//   GET /api/plex?note=<vault-relative-path>   -> the walk for one note
//   GET /api/plex?q=<term>                     -> title/filename search

export const dynamic = "force-dynamic";

const VAULT = process.env.MWP_VAULT || "/Users/silverhawk/GitHub/MWP";
const PLEX_FIELDS = new Set(["parents", "children", "friends", "challengers", "challenger", "up", "down"]);

type PlexNode = { title: string; path: string | null };
type WalkPayload = {
  path: string;
  title: string;
  parents: PlexNode[];
  children: PlexNode[];
  friends: PlexNode[];
  challengers: PlexNode[];
};
type SearchItem = { title: string; path: string };

function safeJoin(rel: string): string | null {
  const cleaned = rel.replace(/^\/+/, "");
  const full = path.normalize(path.join(VAULT, cleaned));
  if (full !== VAULT && !full.startsWith(VAULT + path.sep)) return null;
  return full;
}

// ---- md file index (cached 30s) for ref resolution + search ----
let cache: { at: number; files: string[] } = { at: 0, files: [] };
function mdFiles(): string[] {
  if (Date.now() - cache.at < 30_000) return cache.files;
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || out.length > 20000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".md") || e.name.endsWith(".canvas")) out.push(p);
    }
  };
  walk(VAULT, 0);
  cache = { at: Date.now(), files: out };
  return out;
}

function noteTitle(full: string, raw: string): string {
  const fmTitle = raw.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  if (fmTitle) return fmTitle[1];
  const h1 = raw.split("\n").find((l) => l.startsWith("# "));
  if (h1) return h1.slice(2).trim();
  return path.basename(full).replace(/\.md$/, "");
}

function fmRelations(raw: string): Record<string, string[]> {
  const fm = raw.match(/^---\n(.*?)\n---/s);
  const parts: Record<string, string[]> = {};
  if (!fm) return parts;
  let cur: string | null = null;
  for (const line of fm[1].split("\n")) {
    const km = line.match(/^([\w-]+):\s*(.*)$/);
    if (km) {
      const key = km[1].toLowerCase();
      cur = PLEX_FIELDS.has(key) ? key : null;
      if (cur && km[2].trim()) parts[cur] = [...(parts[cur] ?? []), km[2].trim()];
    } else if (cur && /^[ \t]/.test(line)) {
      const item = line.trim().replace(/^[-*]\s*/, "");
      if (item) parts[cur] = [...(parts[cur] ?? []), item];
    }
  }
  // up:/down: fold into parents/children (honeyui alias rule)
  parts.parents = [...(parts.parents ?? []), ...(parts.up ?? [])];
  parts.children = [...(parts.children ?? []), ...(parts.down ?? [])];
  return parts;
}

function stripWiki(ref: string): string {
  return ref.replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
}

function resolveRef(refRaw: string): { title: string; path: string | null } {
  const ref = stripWiki(refRaw);
  // direct vault-relative try
  for (const candidate of [ref, `${ref}.md`]) {
    const full = safeJoin(candidate);
    if (full && fs.existsSync(full) && fs.statSync(full).isFile()) {
      return { title: path.basename(full).replace(/\.md$/, ""), path: full.slice(VAULT.length + 1) };
    }
  }
  // basename match
  const base = path.basename(ref).replace(/\.md$/, "");
  const hit = mdFiles().find((f) => path.basename(f).replace(/\.md$/, "") === base);
  if (hit) return { title: base, path: hit.slice(VAULT.length + 1) };
  return { title: ref, path: null };
}

function walk(noteRel: string): WalkPayload | null {
  const full = safeJoin(noteRel);
  if (!full || !fs.existsSync(full) || !full.endsWith(".md")) return null;
  const raw = fs.readFileSync(full, "utf8");
  const rels = fmRelations(raw);
  const map = (list: string[] | undefined) =>
    (list ?? []).map(resolveRef).filter((n) => n.path !== null || n.title);
  const challengers = [
    ...(rels.challengers ?? []),
    ...(rels.challenger ?? []),
  ];
  return {
    path: full.slice(VAULT.length + 1),
    title: noteTitle(full, raw),
    parents: map(rels.parents),
    children: map(rels.children),
    friends: map(rels.friends),
    challengers: challengers.length ? map(challengers) : [],
  };
}

function search(q: string): SearchItem[] {
  const needle = q.toLowerCase();
  return mdFiles()
    .filter((f) => path.basename(f).toLowerCase().includes(needle))
    .slice(0, 15)
    .map((f) => ({
      path: f.slice(VAULT.length + 1),
      title: path.basename(f).replace(/\.md$/, ""),
    }));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const note = url.searchParams.get("note");
  const q = url.searchParams.get("q");
  try {
    if (note) {
      const payload = walk(note);
      if (!payload) return NextResponse.json({ error: "note not found" }, { status: 404 });
      return NextResponse.json(payload);
    }
    if (q) return NextResponse.json({ results: search(q) });
    return NextResponse.json({ error: "note or q required" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
