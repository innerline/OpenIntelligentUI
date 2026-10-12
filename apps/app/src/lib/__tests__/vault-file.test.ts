import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readVaultFile } from "@/lib/vault-file";

// The path-safety behind /vault — the receipt route's proven rules,
// exercised against a scratch vault: traversal and .git blocked,
// non-notes refused, missing files 404, good paths resolve inside the
// root. The real vault root is never touched (rootOverride).

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "vault-file-"));
  mkdirSync(join(root, "kanban"), { recursive: true });
  writeFileSync(join(root, "kanban/card.md"), "# Card\n\nbody\n");
  writeFileSync(join(root, "map.canvas"), "{}\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("readVaultFile", () => {
  it("resolves a vault-relative note and reads it", () => {
    const r = readVaultFile("kanban/card.md", root);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.abs.startsWith(root)).toBe(true);
      expect(r.content).toContain("# Card");
    }
  });

  it("accepts canvases too", () => {
    expect(readVaultFile("map.canvas", root).ok).toBe(true);
  });

  it("blocks relative traversal out of the vault", () => {
    expect(readVaultFile("../../../etc/passwd", root)).toEqual({
      ok: false,
      status: 400,
      message: "path outside the vault",
    });
  });

  it("blocks absolute paths outside the vault", () => {
    expect(readVaultFile("/etc/passwd", root).ok).toBe(false);
  });

  it("blocks .git paths even when they resolve inside the root", () => {
    const r = readVaultFile(".git/config", root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("refuses anything but notes and canvases", () => {
    const r = readVaultFile("kanban/card.md.exe", root);
    expect(r).toEqual({
      ok: false,
      status: 400,
      message: "only vault notes and canvases open here",
    });
  });

  it("404s a well-formed path that is not on disk", () => {
    expect(readVaultFile("kanban/nope.md", root)).toEqual({
      ok: false,
      status: 404,
      message: "file not found in the vault",
    });
  });

  it("asks for ?file= when the param is missing", () => {
    expect(readVaultFile(undefined, root)).toEqual({
      ok: false,
      status: 400,
      message: "pass ?file=<vault path>",
    });
    expect(readVaultFile("", root).ok).toBe(false);
  });
});
