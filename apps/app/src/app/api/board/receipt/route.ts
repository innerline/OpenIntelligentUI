import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

// Receipt click-through for the k-plex sidebar: every run/history row links
// here and opens the REAL artifact — the vault commit (`git show`) or the
// vault file itself (card, map, episodic note). Read-only, vault-scoped.
// The repo is private on GitHub, so receipts resolve locally, not via URLs
// that would 404 logged-out.
// `vault=personal` scopes the file read to the Personal vault (Larry's
// myPKA task cards) — same read-only rules, separate root.

export const dynamic = "force-dynamic";

const VAULT = process.env.MWP_VAULT || "/Users/silverhawk/GitHub/MWP";
const PERSONAL_VAULT =
  process.env.PERSONAL_VAULT ||
  "/Users/silverhawk/Library/Mobile Documents/iCloud~md~obsidian/Documents/Personal";

const text = (body: string, status = 200) =>
  new NextResponse(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const commit = searchParams.get("commit");
  const file = searchParams.get("file");
  const vault = searchParams.get("vault") === "personal" ? "personal" : "mwp";
  const ROOT = path.resolve(vault === "personal" ? PERSONAL_VAULT : VAULT);

  if (commit) {
    if (vault === "personal") return text("commits are MWP-vault only", 400);
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) return text("bad commit id", 400);
    try {
      const out = execFileSync(
        "git",
        ["-C", VAULT, "show", "--stat", "--format=fuller", commit],
        { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 },
      );
      return text(out || "(empty commit)");
    } catch {
      return text("commit not found in the vault", 404);
    }
  }

  if (file) {
    const resolved = path.resolve(ROOT, file);
    if (
      resolved !== ROOT && !resolved.startsWith(ROOT + path.sep) ||
      /(\.\.|\.git)/i.test(file)
    )
      return text("path outside the vault", 400);
    if (!/\.(md|canvas)$/i.test(resolved))
      return text("only vault notes and canvases open here", 400);
    try {
      return text(fs.readFileSync(resolved, "utf8"));
    } catch {
      return text("file not found in the vault", 404);
    }
  }

  return text("pass ?commit=<hash> or ?file=<vault path>", 400);
}
