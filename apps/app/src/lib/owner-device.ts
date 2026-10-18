// Owner device detection — the cockpit's half of the device input matrix
// (MWP kanban/device-input-matrix, owner directive 2026-10-18: "Phone,
// iPad, Laptop, and default at the studio"). Every outbound chat run
// carries the tag so Honey and Larry adapt their feedback automatically:
// phone = short/voice-ready, iPad = excalidraw canvas, laptop = K-Plex
// visuals, studio = full cockpit.
//
// Classification is SERVER-SIDE (owner hit #3, 2026-10-18): a browser
// cannot tell which physical desk a desktop sits at, but the server sees
// the connecting machine's address. The /api/copilotkit edge stamps the
// browser's real peer address + User-Agent onto every proxied run
// (forwardedProps.devicePeer / deviceUserAgent) and the ADAPTER resolves
// the tag: pin → UA phone/ipad → peer (loopback/Studio address = studio,
// any other = laptop) → this client guess → studio. The layers here:
//   1. OVERRIDE — the owner's manual pin (the device chip in the chat
//      header writes it, localStorage key owner-device-override). The
//      pin is sent SOURCED (deviceSource: "pin") and beats every
//      server-side signal — when the machine genuinely sits at the
//      wrong desk for its address, the owner's word is final.
//   2. HEURISTIC — the no-override initial guess, now only a
//      last-resort FALLBACK payload (deviceSource: "heuristic") for
//      when the server could not classify:
//     phone  — iPhone/Android UA, or any narrow (<768px) viewport
//     ipad   — iPad UA, or a desktop-mode iPad (touch + 768–1366px)
//     laptop — desktop browser served from a NON-loopback host
//     studio — desktop browser on a loopback page origin, and the
//              fallback when nothing classifies
//
// Known weakness (documented, superseded): loopback-as-studio misfired
// whenever the laptop reached the cockpit through a loopback-shaped
// path (2026-10-18, three owner hits). The server-side peer lanes now
// answer before this guess; the pin remains the override for the
// shapes no address can settle (e.g. a pure SSH tunnel sources
// loopback). The adapter ALSO defaults a missing tag to studio, so even
// a mis-detected client can only ever land the owner on the
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

// Where the tag came from. "pin" — the owner's manual override, sent
// alongside the device so the ADAPTER can tell the owner's word from
// the browser's guess apart: a pin beats every server-side signal
// (peer address, UA), a heuristic guess is only a last-resort fallback
// when the server could not classify.
export type OwnerDeviceSource = "pin" | "heuristic";

export function getOwnerDeviceSource(): OwnerDeviceSource {
  return getOwnerDeviceOverride() !== null ? "pin" : "heuristic";
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
