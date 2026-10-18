// The honeyui render proxy helpers — the Excalidraw map canvas and the
// plex board live in the stack's honeyui renderer (agentic-stack
// honeyui/server.py), keyed by runtime/token. The cockpit embeds that
// renderer through /api/cockpit/honeyui/*: the route forwards
// server-side with the token inlined on EVERY request (token law
// b959ac33 — every owner-facing link carries the token INLINE, the
// owner must never hit a 401), so the token never reaches browser code.
//
// honeyui's page and bundle address themselves with ROOT-absolute URLs
// (/app.js, /api/map, /?t=…), so serving them under the proxy prefix
// takes two anchored rewrites: the page HTML (its <script>/<link> refs)
// and the app.js entry (its "/api/", "/agent" and "/?t=" string
// literals). Lazy chunks import RELATIVE to app.js and ride along
// untouched. Both rewrites are pinned by tests so a honeyui rebuild
// that breaks them fails here, not in the owner's sidebar.

export const HONEYUI_PREFIX = "/api/cockpit/honeyui";

// The one URL for a pointed map or plex — the iframe src in the sidebar
// AND the click-through href (same URL, full page, new tab).
export function honeyuiPageUrl(kind: "map" | "plex", path: string): string {
  return `${HONEYUI_PREFIX}/?${kind}=${encodeURIComponent(path)}`;
}

export function rewriteHoneyuiHtml(html: string): string {
  // index.html references /app.js?v=…, /manifest.webmanifest, /icon-…:
  // root-absolute href/src only — prefix them all.
  return html.replace(
    /(\s(?:src|href)=")(\/[^"]*)/g,
    (_m, attr: string, url: string) => `${attr}${HONEYUI_PREFIX}${url}`,
  );
}

export function rewriteHoneyuiJs(js: string): string {
  // The bundle's root-absolute endpoints, as string literals:
  //   "/api/…"  — every Ie() data fetch (map, plex, file, speak, …)
  //   "/agent?…" — the AG-UI POST lane (unused in the embed, kept true)
  //   "/?t=…"   — keyed receipt links rendered inside replies
  return js
    .replace(/"\/api\//g, `"${HONEYUI_PREFIX}/api/`)
    .replace(/"\/agent\?/g, `"${HONEYUI_PREFIX}/agent?`)
    .replace(/"\/\?t="/g, `"${HONEYUI_PREFIX}/?t="`);
}
