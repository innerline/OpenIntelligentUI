import { describe, expect, it } from "vitest";
import {
  HONEYUI_PREFIX,
  honeyuiPageUrl,
  rewriteHoneyuiHtml,
  rewriteHoneyuiJs,
} from "@/lib/honeyui-proxy";

// The embed lane for Honey's pointed maps and plex walks. honeyui's page
// and bundle address themselves with ROOT-absolute URLs, so serving them
// under the proxy prefix takes anchored rewrites — these tests pin both,
// against the exact shapes honeyui's index.html and app.js emit today. A
// honeyui rebuild that drifts fails here, not in the owner's sidebar.

describe("honeyuiPageUrl", () => {
  it("builds the map page URL with the path encoded", () => {
    expect(honeyuiPageUrl("map", "Vision/Agent Visuals/x.excalidraw.md")).toBe(
      `${HONEYUI_PREFIX}/?map=Vision%2FAgent%20Visuals%2Fx.excalidraw.md`,
    );
  });

  it("builds the plex page URL the same way", () => {
    expect(honeyuiPageUrl("plex", "K-Plex/Mind Map.md")).toBe(
      `${HONEYUI_PREFIX}/?plex=K-Plex%2FMind%20Map.md`,
    );
  });
});

describe("rewriteHoneyuiHtml", () => {
  it("prefixes root-absolute src and href, leaves relatives alone", () => {
    const html =
      `<link rel="manifest" href="/manifest.webmanifest">` +
      `<script type="module" src="/app.js?v=24"></script>` +
      `<img src="shots/x.png">`;
    expect(rewriteHoneyuiHtml(html)).toBe(
      `<link rel="manifest" href="${HONEYUI_PREFIX}/manifest.webmanifest">` +
      `<script type="module" src="${HONEYUI_PREFIX}/app.js?v=24"></script>` +
      `<img src="shots/x.png">`,
    );
  });
});

describe("rewriteHoneyuiJs", () => {
  it("rewrites the bundle's root-absolute endpoint literals", () => {
    const js =
      `const Ie=e=>new URL("/api/"+e+"?t="+tr,location.origin);` +
      `const VS=()=>new URL("/agent?t="+tr,location.origin);` +
      `const s=c=>new URL("/?t="+tr+"&file="+c,location.origin);`;
    expect(rewriteHoneyuiJs(js)).toBe(
      `const Ie=e=>new URL("${HONEYUI_PREFIX}/api/"+e+"?t="+tr,location.origin);` +
      `const VS=()=>new URL("${HONEYUI_PREFIX}/agent?t="+tr,location.origin);` +
      `const s=c=>new URL("${HONEYUI_PREFIX}/?t="+tr+"&file="+c,location.origin);`,
    );
  });

  it("leaves lazy chunk imports and unrelated strings untouched", () => {
    const js = `import("./chunk-OBIKBTOI.js");const a="/apifake/";const b="api/";`;
    expect(rewriteHoneyuiJs(js)).toBe(js);
  });
});
