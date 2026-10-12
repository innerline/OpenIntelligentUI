/**
 * uuid — crypto.randomUUID with an insecure-context fallback.
 *
 * crypto.randomUUID() is only available in SECURE contexts (HTTPS or
 * localhost). The cockpit is served over plain HTTP on the tailnet IP
 * (http://100.81.213.106:3210), where Safari/Chrome do not expose it —
 * owner hit this live on 2026-10-12 (node-click → ask-Honey deep link →
 * "crypto.randomUUID is not a function"). crypto.getRandomValues IS
 * available in insecure contexts, so fall back to an RFC 4122 v4 built
 * from it. Localhost smoke tests pass either way — always use this
 * helper, never crypto.randomUUID directly.
 */
export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
