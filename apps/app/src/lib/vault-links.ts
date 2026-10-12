// Vault link helpers — one place for the two click-through doors.
//
// - The vault door (default http://100.81.213.106:8135) is the owner's
//   own file viewer; links open straight in for his session. Override
//   the base with NEXT_PUBLIC_VAULT_DOOR.
// - The receipt route is the app's same-origin fallback: read-only file
//   contents, scoped per vault (MWP default, Personal for Larry's side).

export const VAULT_DOOR = process.env.NEXT_PUBLIC_VAULT_DOOR || "http://100.81.213.106:8135";

export function doorUrl(file: string): string {
  return `${VAULT_DOOR}/?file=${encodeURIComponent(file)}`;
}

export function receiptUrl(file: string, vault: "mwp" | "personal" = "mwp"): string {
  const q = vault === "personal" ? "?vault=personal&file=" : "?file=";
  return `/api/board/receipt${q}${encodeURIComponent(file)}`;
}
