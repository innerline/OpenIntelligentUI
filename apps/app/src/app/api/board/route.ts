import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// The dashboard data: parsed live from the MWP vault on this machine.
// Open (owner asks) / Running (agent cards) / Done (finished, recent).

const VAULT = process.env.MWP_VAULT || "/Users/silverhawk/GitHub/MWP";

function frontmatter(file: string) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    const fm: Record<string, string> = {};
    if (lines[0]?.trim() !== "---") return { fm, title: path.basename(file, ".md") };
    for (const ln of lines.slice(1, 25)) {
      if (ln.trim() === "---") break;
      const m = ln.match(/^([a-z_]+):\s*(.*)$/i);
      if (m) fm[m[1]] = m[2].trim();
    }
    const title = lines.find((l) => l.startsWith("# "))?.slice(2).trim()
      || path.basename(file, ".md");
    return { fm, title };
  } catch { return { fm: {} as Record<string, string>, title: "" }; }
}

export async function GET() {
  try {
    // 1) Open asks: unchecked lines under LIVE BLOCKS in OWNER-ACTIONS
    const open: { text: string; kind: string }[] = [];
    try {
      const oa = fs.readFileSync(path.join(VAULT, "kanban/OWNER-ACTIONS.md"), "utf8");
      let live = false;
      for (const ln of oa.split("\n")) {
        if (ln.startsWith("# ")) { live = ln.includes("LIVE BLOCKS"); continue; }
        if (!live || !ln.trim().startsWith("- [ ]")) continue;
        const t = ln.split("- [ ]")[1]?.trim(); if (!t) continue;
        const kind = t.includes("PICK:") ? "pick" : (t.startsWith("(PARKED") || t.startsWith("(OPTIONAL")) ? "parked" : "action";
        open.push({ text: t.slice(0, 200), kind });
      }
    } catch {}

    // 2+3) Cards: running / ready / review / block / done (recent by mtime)
    const running: { slug: string; title: string; status: string; owner: string }[] = [];
    const waiting: { slug: string; title: string; status: string; owner: string }[] = [];
    const done: { slug: string; title: string; owner: string; when: string }[] = [];
    const dir = path.join(VAULT, "kanban");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    const withMtime = files.map((f) => ({
      f, m: fs.statSync(path.join(dir, f)).mtimeMs,
    })).sort((a, b) => b.m - a.m);
    for (const { f } of withMtime) {
      if (f === "OWNER-ACTIONS.md" || f === "STATUSES.md") continue;
      const { fm, title } = frontmatter(path.join(dir, f));
      const status = fm.status || "";
      const slug = f.replace(/\.md$/, "");
      if (status === "running" || status === "ready")
        running.push({ slug, title: title.slice(0, 70), status, owner: fm.owner || "?" });
      else if (status === "block" || status === "review")
        waiting.push({ slug, title: title.slice(0, 70), status, owner: fm.owner || "?" });
      else if (status === "done") {
        const when = new Date(fs.statSync(path.join(dir, f)).mtimeMs);
        if (Date.now() - when.getTime() < 14 * 864e5)
          done.push({ slug, title: title.slice(0, 70), owner: fm.owner || "?",
            when: when.toISOString().slice(0, 10) });
      }
      if (done.length >= 15 && running.length > 20) break;
    }
    return NextResponse.json({ open, running, waiting, done, generated: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
