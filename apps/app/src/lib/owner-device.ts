// Owner device detection — the cockpit's half of the device input matrix
// (MWP kanban/device-input-matrix, owner directive 2026-10-18: "Phone,
// iPad, Laptop, and default at the studio"). Every outbound chat run
// carries the tag so Honey and Larry adapt their feedback automatically:
// phone = short/voice-ready, iPad = excalidraw canvas, laptop = K-Plex
// visuals, studio = full cockpit.
//
// Coarse BY DESIGN — four buckets, decided once per mount:
//   phone  — iPhone/Android UA, or any narrow (<768px) viewport
//   ipad   — iPad UA, or a desktop-mode iPad (touch + 768–1366px)
//   laptop — desktop browser served from a NON-loopback host
//   studio — desktop browser on the Studio host itself (loopback page
//            origin), and the fallback when nothing classifies
//
// Loopback-as-studio is the one heuristic: a browser viewing a page
// served from 127.0.0.1/localhost is on the machine that served it —
// in production that machine is the Studio. The adapter ALSO defaults
// a missing tag to studio, so even a mis-detected client can only ever
// land the owner on the full-cockpit contract.

export type OwnerDevice = "phone" | "ipad" | "laptop" | "studio";

export function detectOwnerDevice(): OwnerDevice {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "studio"; // SSR/prerender placeholder — never rendered, never sent
  }
  const ua = navigator.userAgent || "";
  const touchPoints = (navigator as Navigator & { maxTouchPoints?: number })
    .maxTouchPoints ?? 0;
  const width = typeof window.innerWidth === "number" ? window.innerWidth : 0;

  if (/iPad/i.test(ua)) return "ipad";
  if (/iPhone|iPod/i.test(ua)) return "phone";
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return "phone";
  // Desktop-mode iPad Safari claims to be Macintosh but is touch-first
  // at an iPad-sized viewport (a real Mac has no multi-touch screen).
  if (/Macintosh/i.test(ua) && touchPoints > 1 && width >= 768 && width <= 1366) {
    return "ipad";
  }
  if (width > 0 && width < 768) return "phone";

  const host = window.location?.hostname ?? "";
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  return loopback ? "studio" : "laptop";
}
