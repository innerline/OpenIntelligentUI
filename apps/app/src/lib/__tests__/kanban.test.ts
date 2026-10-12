import { describe, expect, it } from "vitest";
import {
  parseFrontmatter,
  parseStatusVocabulary,
  parseTags,
  stripValue,
  titleOf,
} from "@/lib/kanban";

// The vault-side parsers behind /api/board's kanban mirror and
// /api/larry-tasks. Fixtures are inline (no disk) and mirror the real
// shapes: MWP cards with `status:` frontmatter, Personal vault task
// files with `# section` comments inside the fence, quoted values.

const MWP_CARD = `---
type: task
status: running
owner: honey
tags: [cockpit, redesign]
created: 2026-10-12
---

# Cockpit redesign

Body lines.
`;

const PERSONAL_TASK = `---
# Identity
id: tsk-2026-05-10-001
title: "Welcome — read this and then close me"

# Ownership & priority
assignee: larry
priority: 4

# Status
status: open
blocked_reason: null
---

# Welcome

Body.
`;

const STATUSES_MD = `# Kanban statuses — the shared vocabulary

| Status | Meaning | Who moves it |
| --- | --- | --- |
| \`triage\` | raw idea — needs fleshing into a real task | any agent or Brian |
| \`todo\` | real task, waiting on dependencies or unassigned | dispatcher/orchestrator |
| \`running\` | claimed, work in progress | the working agent |
| \`block\` | **waiting for human input — a review gate** | the working agent |
| \`done\` | closed, receipt in the commit message | after review |
`;

describe("parseFrontmatter", () => {
  it("reads MWP-style card frontmatter", () => {
    const fm = parseFrontmatter(MWP_CARD);
    expect(fm.status).toBe("running");
    expect(fm.owner).toBe("honey");
    expect(fm.type).toBe("task");
  });

  it("skips # section comments inside the fence (Personal task files)", () => {
    const fm = parseFrontmatter(PERSONAL_TASK);
    expect(fm.title).toBe("Welcome — read this and then close me");
    expect(fm.assignee).toBe("larry");
    expect(fm.status).toBe("open");
    expect(fm.blocked_reason).toBe("null");
    expect(fm["# Identity"]).toBeUndefined();
  });

  it("returns {} without frontmatter", () => {
    expect(parseFrontmatter("# just a heading\n")).toEqual({});
    expect(parseFrontmatter("plain text")).toEqual({});
  });

  it("stops at the closing fence within 60 lines", () => {
    const long = "---\nstatus: todo\n" + "x\n".repeat(80);
    expect(parseFrontmatter(long)).toEqual({ status: "todo" });
  });
});

describe("stripValue / parseTags / titleOf", () => {
  it("strips matching quotes", () => {
    expect(stripValue('"hello"')).toBe("hello");
    expect(stripValue("'hello'")).toBe("hello");
    expect(stripValue(" plain ")).toBe("plain");
    expect(stripValue('"unclosed')).toBe('"unclosed');
  });

  it("parses bracketed and single tags", () => {
    expect(parseTags("[a, b, c]")).toEqual(["a", "b", "c"]);
    expect(parseTags("solo")).toEqual(["solo"]);
    expect(parseTags(undefined)).toEqual([]);
  });

  it("falls back to the filename when no h1 exists", () => {
    expect(titleOf("no heading", "fallback.md")).toBe("fallback.md");
    expect(titleOf("# Real Title\n", "fallback.md")).toBe("Real Title");
  });
});

describe("parseStatusVocabulary (STATUSES.md)", () => {
  it("extracts the status table rows in order", () => {
    const cols = parseStatusVocabulary(STATUSES_MD);
    expect(cols.map((c) => c.key)).toEqual(["triage", "todo", "running", "block", "done"]);
    expect(cols[0].note).toMatch(/raw idea/);
  });

  it("returns [] for a file with no table", () => {
    expect(parseStatusVocabulary("# nothing here")).toEqual([]);
  });
});
