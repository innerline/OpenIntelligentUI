import fs from "fs";
import path from "path";

// Shared path-safety for reading a vault file off a request — the exact
// validation /api/board/receipt has proven in production: traversal-
// blocked, .git-blocked, vault-scoped, notes and canvases only. The
// /vault viewer reuses these rules; there is no second invention of
// them. `rootOverride` exists for tests (scratch vault fixtures).

export type VaultFileResult =
  | { ok: true; abs: string; content: string }
  | { ok: false; status: 400 | 404; message: string };

export function readVaultFile(
  file: string | null | undefined,
  rootOverride?: string,
): VaultFileResult {
  if (!file) return { ok: false, status: 400, message: "pass ?file=<vault path>" };
  const ROOT = path.resolve(
    rootOverride ?? process.env.MWP_VAULT || "/Users/silverhawk/GitHub/MWP",
  );
  const resolved = path.resolve(ROOT, file);
  if (
    resolved !== ROOT && !resolved.startsWith(ROOT + path.sep) ||
    /(\.\.|\.git)/i.test(file)
  )
    return { ok: false, status: 400, message: "path outside the vault" };
  if (!/\.(md|canvas)$/i.test(resolved))
    return { ok: false, status: 400, message: "only vault notes and canvases open here" };
  try {
    return { ok: true, abs: resolved, content: fs.readFileSync(resolved, "utf8") };
  } catch {
    return { ok: false, status: 404, message: "file not found in the vault" };
  }
}
