// Vault link helpers — one place for the click-through doors.
//
// - /vault is the app's OWN read-only vault file viewer (owner ruling
//   2026-10-12, ending the two-front-door confusion: the cockpit is
//   self-contained and nothing here links out to the old keyed door).
//   Old-world keyed links (?t=<token>) still land — the viewer reads
//   the token param and ignores it.
// - The receipt route stays for commit receipts and Personal-vault
//   files (Larry's side): raw text, scoped per vault.

export function doorUrl(file: string): string {
  return `/vault?file=${encodeURIComponent(file)}`;
}

export function receiptUrl(file: string, vault: "mwp" | "personal" = "mwp"): string {
  const q = vault === "personal" ? "?vault=personal&file=" : "?file=";
  return `/api/board/receipt${q}${encodeURIComponent(file)}`;
}
