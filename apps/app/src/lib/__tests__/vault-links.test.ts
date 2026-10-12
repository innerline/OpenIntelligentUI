import { describe, expect, it } from "vitest";
import { doorUrl, receiptUrl } from "@/lib/vault-links";

// The click-through doors: since 2026-10-12 every vault-file link the
// cockpit renders stays SAME-ORIGIN — /vault for MWP files, the receipt
// route for commits and the Personal vault. No :8135 anywhere.

describe("doorUrl", () => {
  it("links into the app's own /vault viewer", () => {
    expect(doorUrl("kanban/suite-cockpit-build.md")).toBe(
      "/vault?file=kanban%2Fsuite-cockpit-build.md",
    );
  });

  it("never carries a host — the app is the only front door", () => {
    expect(doorUrl("Vision/The Big Vision.excalidraw.md")).not.toMatch(/^https?:/);
    expect(doorUrl("a b&c.md")).toBe("/vault?file=a%20b%26c.md");
  });
});

describe("receiptUrl", () => {
  it("keeps MWP file receipts on the receipt route", () => {
    expect(receiptUrl("kanban/x.md")).toBe("/api/board/receipt?file=kanban%2Fx.md");
  });

  it("scopes Personal-vault files with ?vault=personal", () => {
    expect(receiptUrl("Tasks/x.md", "personal")).toBe(
      "/api/board/receipt?vault=personal&file=Tasks%2Fx.md",
    );
  });
});
