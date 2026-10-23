// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { listPulseEvents } from "@/lib/pulse";

// lib/pulse (THE REDO J07): the stage-02 C2 contract parse — Daily/pulse
// is the feed, one typed note per shipped run, newest-first by filename
// (files are date-prefixed). Real fixture dir in a tmpdir, same style as
// lib/kanban's tests.

const note = (name: string, fm: Record<string, string>, body = "Body.") =>
  `---\ntype: pulse-event\n${Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\n\n${body}\n`;

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-pulse-"));
  const feed = path.join(dir, "pulse");
  fs.mkdirSync(feed);
  fs.writeFileSync(
    path.join(feed, "2026-10-09-kplex-dashboard-stage-03.md"),
    note(
      "stage-03",
      {
        event: "build",
        title: "k-plex dashboard stage-03 SHIPPED",
        date: "2026-10-09",
        seat: "copilot",
        project: "k-plex dashboard",
        receipt: "copilot/projects/k-plex project/stage-03-build-receipt.md",
        commit: "a05dd80",
      },
      "Stage 03 deployed: tabs on the Honey/Larry UI.",
    ),
  );
  fs.writeFileSync(
    path.join(feed, "2026-10-23-redo-p1.md"),
    note(
      "redo-p1",
      { event: "gate", title: "P1 at the owner gate", date: "2026-10-23", seat: "opencode" },
      "Cockpit increment receipt.",
    ),
  );
  // no receipt / no event / no seat — still a feed row, just unchipped
  fs.writeFileSync(
    path.join(feed, "2026-10-22-bare.md"),
    `---\ntype: pulse-event\ntitle: "A bare run"\ndate: 2026-10-22\n---\n\nShort.\n`,
  );
  return feed;
}

describe("listPulseEvents", () => {
  it("reads the feed newest-first by filename, frontmatter mapped", () => {
    const events = listPulseEvents(fixture(), { prefix: "Daily/pulse" });
    expect(events.map((e) => e.file)).toEqual([
      "2026-10-23-redo-p1.md",
      "2026-10-22-bare.md",
      "2026-10-09-kplex-dashboard-stage-03.md",
    ]);
    const e = events[2];
    expect(e.path).toBe("Daily/pulse/2026-10-09-kplex-dashboard-stage-03.md");
    expect(e.title).toBe("k-plex dashboard stage-03 SHIPPED");
    expect(e.event).toBe("build");
    expect(e.seat).toBe("copilot");
    expect(e.receipt).toBe(
      "copilot/projects/k-plex project/stage-03-build-receipt.md",
    );
    expect(e.commit).toBe("a05dd80");
    expect(e.body).toContain("Stage 03 deployed");
  });

  it("keeps bare rows (no event/seat/receipt) with empty strings", () => {
    const events = listPulseEvents(fixture(), { prefix: "Daily/pulse" });
    const bare = events.find((e) => e.file === "2026-10-22-bare.md")!;
    expect(bare.title).toBe("A bare run");
    expect(bare.event).toBe("");
    expect(bare.seat).toBe("");
    expect(bare.receipt).toBe("");
  });

  it("caps at the limit", () => {
    const events = listPulseEvents(fixture(), { prefix: "Daily/pulse", limit: 1 });
    expect(events).toHaveLength(1);
    expect(events[0].file).toBe("2026-10-23-redo-p1.md");
  });

  it("an unreadable dir is an empty feed, never a throw", () => {
    expect(
      listPulseEvents(path.join(os.tmpdir(), "cockpit-pulse-missing"), {
        prefix: "Daily/pulse",
      }),
    ).toEqual([]);
  });

  it("a fenceless note never has its body sliced by a --- rule", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-pulse-nf-"));
    fs.writeFileSync(
      path.join(dir, "2026-10-23-no-fence.md"),
      "# Just a heading\n\nbefore\n\n---\n\nafter the rule\n",
    );
    const [e] = listPulseEvents(dir, { prefix: "Daily/pulse" });
    expect(e.title).toBe("Just a heading");
    expect(e.body).toContain("before");
    expect(e.body).toContain("after the rule");
  });
});
