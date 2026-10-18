// Owner device detection — the cockpit's half of the device input matrix
// (MWP kanban/device-input-matrix, owner directive 2026-10-18: "Phone,
// iPad, Laptop, and default at the studio"). Every outbound chat run
// carries the tag so Honey and Larry adapt their feedback automatically:
// phone = short/voice-ready, iPad = excalidraw canvas, laptop = K-Plex
// visuals, studio = full cockpit.
//
// Two layers, the pin above the guess:
//   1. OVERRIDE — the owner's manual pin (the device chip in the chat
//      header writes it, localStorage key owner-device-override). A
//      browser fundamentally cannot tell which physical desk a desktop
//      sits at, so when the guess is wrong the owner pins the truth
//      once per browser and the pin always beats the guess.
//   2. HEURISTIC — the no-override initial guess, coarse by design:
//     phone  — iPhone/Android UA, or any narrow (<768px) viewport
//     ipad   — iPad UA, or a desktop-mode iPad (touch + 768–1366px)
//     laptop — desktop browser served from a NON-loopback host
//     studio — desktop browser on a loopback page origin, and the
//              fallback when nothing classifies
//
// Known weakness (documented, not fixed): loopback-as-studio misfires
// whenever the laptop reaches the cockpit through a loopback-shaped
// path — an SSH tunnel, a localhost URL on a forwarded port (exactly
// the 2026-10-18 misfire: owner on his laptop, tagged "studio"). No
// browser-side heuristic can resolve which machine a desktop class of
// client sits at, so the override is the answer, not a smarter guess.
// The adapter ALSO defaults a missing tag to studio, so even a
// mis-detected client can only ever land the owner on the
// full-cockpit contract.

export type OwnerDevice = "phone" | "ipad" | "laptop" | "studio";

export const OWNER_DEVICES: readonly OwnerDevice[] = [
  "phone",
  "ipad",
  "laptop",
  "studio",
];

// localStorage key holding the owner's manual pin (the chip writes it).
export const OWNER_DEVICE_OVERRIDE_KEY = "owner-device-override";

// Window event fired after the override changes. Surfaces capture
// detectOwnerDevice() once per mount (provider properties, engine-chat
// send tag), so they listen for this and re-read — the NEXT run carries
// the new tag without a remount. (localStorage's own `storage` event
// only reaches OTHER tabs, not the writer's.)
export const OWNER_DEVICE_CHANGED_EVENT = "owner-device-changed";

export function isOwnerDevice(value: unknown): value is OwnerDevice {
  return (
    typeof value === "string" &&
    (OWNER_DEVICES as readonly string[]).includes(value)
  );
}

// The owner's pinned device, or null when this browser still runs on
// the heuristic. A value that isn't one of the four buckets is ignored,
// not trusted — a corrupt pin can never wedge detection.
export function getOwnerDeviceOverride(): OwnerDevice | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(OWNER_DEVICE_OVERRIDE_KEY);
    return isOwnerDevice(raw) ? raw : null;
  } catch {
    return null; // storage blocked (private mode): heuristic still answers
  }
}

// Pin the truth (device) or drop back to the guess (null). Always
// notifies listeners even when storage is blocked — this mount's tag
// still updates.
export function setOwnerDeviceOverride(device: OwnerDevice | null): void {
  try {
    if (device === null) {
      window.localStorage.removeItem(OWNER_DEVICE_OVERRIDE_KEY);
    } else {
      window.localStorage.setItem(OWNER_DEVICE_OVERRIDE_KEY, device);
    }
  } catch {
    // storage blocked: the event below still updates this mount
  }
  window.dispatchEvent(new Event(OWNER_DEVICE_CHANGED_EVENT));
}

export function detectOwnerDevice(): OwnerDevice {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "studio"; // SSR/prerender placeholder — never rendered, never sent
  }
  const override = getOwnerDeviceOverride();
  if (override) return override; // the pin beats every guess
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
