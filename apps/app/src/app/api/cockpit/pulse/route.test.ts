// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { GET } from "./route";

// /api/cockpit/pulse — the J07 dashboard lane: pure read of the vault's
// Daily/pulse/*.md, newest-first, 503 when the vault is unreadable (a
// missing feed and an empty feed must never look the same). Fixture
// vault in a tmpdir, same style as the board route's tests.

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-pulse-route-"));
  const feed = path.join(dir, "Daily", "pulse");
  fs.mkdirSync(feed, { recursive: true });
  fs.writeFileSync(
    path.join(feed, "2026-10-23-redo-p1.md"),
    '---\ntype: pulse-event\nevent: gate\ntitle: "P1 at the owner gate"\ndate: 2026-10-23\nseat: opencode\nreceipt: kanban/the-redo.md\n---\n\nCockpit increment receipt.\n',
  );
  fs.writeFileSync(
    path.join(feed, "2026-10-09-kplex-dashboard-stage-03.md"),
    '---\ntype: pulse-event\nevent: build\ntitle: "stage-03 SHIPPED"\ndate: 2026-10-09\nseat: copilot\n---\n\nTabs live.\n',
  );
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/cockpit/pulse", () => {
  it("returns the feed newest-first with generated stamp", async () => {
    vi.stubEnv("MWP_VAULT", fixture());
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const p = await res.json();
    expect(p.events.map((e: { file: string }) => e.file)).toEqual([
      "2026-10-23-redo-p1.md",
      "2026-10-09-kplex-dashboard-stage-03.md",
    ]);
    expect(p.events[0].receipt).toBe("kanban/the-redo.md");
    expect(p.generated).toBeTruthy();
  });

  it("an empty feed is 200 with zero events", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-pulse-empty-"));
    fs.mkdirSync(path.join(dir, "Daily", "pulse"), { recursive: true });
    vi.stubEnv("MWP_VAULT", dir);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).events).toEqual([]);
  });

  it("a missing vault dir is 503, not an empty feed", async () => {
    vi.stubEnv("MWP_VAULT", path.join(os.tmpdir(), "cockpit-pulse-novault-"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "pulse dir not found" });
  });
});
