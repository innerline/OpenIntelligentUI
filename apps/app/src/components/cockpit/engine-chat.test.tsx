import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Providers } from "@/app/providers";
import { EngineChat } from "@/components/cockpit/engine-chat";
import { detectOwnerDevice } from "@/lib/owner-device";

// Cross-device rejoin (kanban/cockpit-thread-continuity, 2026-10-18):
// the localStorage pin is per browser, so each device minted its own
// thread. On mount the chat asks /api/cockpit/thread-current for the
// persona's anchor (the adapter's most recently active thread) and adopts
// it while still idle — re-pinning localStorage and restoring the anchor
// thread's history instead of forking a parallel conversation.

const PIN_KEY = "cockpit.thread.honey";

// Same shape as shared-thread.test.tsx's mockRuntime: keep the real SDK
// providers/agent internals, replace only the HTTP boundary. runPayloads
// records every agent run body the surface fires (device tag lives there,
// kanban/device-input-matrix). visual rides RUN_FINISHED's result — the
// adapter's parsed VISUAL machine line (slice 2).
function mockFetch(
  anchor: string | null,
  transcripts: Record<string, unknown>,
  runVisual: unknown = undefined,
) {
  const threadFetches: string[] = [];
  const runPayloads: Record<string, unknown>[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/provider-keys") return Response.json({ ok: true });
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (body.method === "info" || url.endsWith("/info")) {
      return Response.json({
        version: "1.55.2-next.1",
        agents: {
          default: { description: "Default agent" },
          honey: { description: "Honey" },
        },
      });
    }
    if (url.startsWith("/api/cockpit/thread-current")) {
      return Response.json({ threadId: anchor, agent: "honey" });
    }
    if (url.startsWith("/api/cockpit/thread-messages")) {
      threadFetches.push(url);
      const thread = new URL(url, "http://x").searchParams.get("thread") ?? "";
      const messages = transcripts[thread] ?? [];
      return Response.json({ threadId: thread, messages });
    }
    const payload = body.body ?? body;
    if (payload && typeof payload === "object" && "runId" in payload) {
      runPayloads.push(payload as Record<string, unknown>);
    }
    const connecting =
      body.method === "agent/connect" || url.endsWith("/connect");
    const events = [
      { type: "RUN_STARTED", threadId: payload.threadId, runId: payload.runId },
      ...(connecting ? [{ type: "MESSAGES_SNAPSHOT", messages: [] }] : []),
      ...(runVisual !== undefined
        ? [
            {
              type: "RUN_FINISHED",
              threadId: payload.threadId,
              runId: payload.runId,
              result: { visual: runVisual },
            },
          ]
        : [
            {
              type: "RUN_FINISHED",
              threadId: payload.threadId,
              runId: payload.runId,
              result: { visual: null },
            },
          ]),
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  return { fn, threadFetches, runPayloads };
}

beforeEach(() => {
  window.localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function chat() {
  return render(
    <Providers>
      <EngineChat
        agentId="honey"
        title="Honey"
        endpoint="http://127.0.0.1:8126/"
        welcome="Honey, here."
        placeholder="Talk to Honey…"
      />
    </Providers>,
  );
}

it("adopts the persona anchor over a stale local pin and re-pins storage", async () => {
  // this browser still pins yesterday's thread; the anchor is the thread
  // that saw the last completed turn on any device
  window.localStorage.setItem(PIN_KEY, "web-stale-pin");
  const { fn, threadFetches } = mockFetch("web-anchor", {
    "web-anchor": [{ role: "user", content: "from the other device" }],
  });
  vi.stubGlobal("fetch", fn);

  chat();

  await waitFor(() =>
    expect(window.localStorage.getItem(PIN_KEY)).toBe("web-anchor"),
  );
  // the adopted thread's history is what got restored
  await waitFor(() =>
    expect(
      threadFetches.some((u) => u.includes("thread=web-anchor")),
    ).toBe(true),
  );
  expect(
    threadFetches.some((u) => u.includes("thread=web-stale-pin")),
  ).toBe(true); // the pin was tried first, then swapped
});

it("keeps its pin when the anchor agrees with it", async () => {
  window.localStorage.setItem(PIN_KEY, "web-current");
  const { fn, threadFetches } = mockFetch("web-current", {});
  vi.stubGlobal("fetch", fn);

  chat();

  await waitFor(() =>
    expect(
      threadFetches.some((u) => u.includes("thread=web-current")),
    ).toBe(true),
  );
  expect(window.localStorage.getItem(PIN_KEY)).toBe("web-current");
});

it("keeps its pinned thread when the adapter anchor is unreachable", async () => {
  window.localStorage.setItem(PIN_KEY, "web-offline-pin");
  const { fn, threadFetches } = mockFetch(null, {});
  vi.stubGlobal("fetch", fn);

  chat();

  await waitFor(() =>
    expect(
      threadFetches.some((u) => u.includes("thread=web-offline-pin")),
    ).toBe(true),
  );
  expect(window.localStorage.getItem(PIN_KEY)).toBe("web-offline-pin");
});

// --- Device input matrix (kanban/device-input-matrix, 2026-10-18) ---
// Coarse client-side detection: phone | ipad | laptop | studio, decided
// once per mount; the tag rides every outbound run as
// forwardedProps.device and the adapter turns it into the one-line
// feedback contract at the top of the engine's input.

const DETECTOR_RESTORE: (() => void)[] = [];
function stubDeviceEnv({ ua, touch = 0, width }: { ua: string; touch?: number; width?: number }) {
  const nav = window.navigator as Navigator & { maxTouchPoints?: number };
  const originals: [object, string, PropertyDescriptor | undefined][] = [
    [nav, "userAgent", Object.getOwnPropertyDescriptor(nav, "userAgent")],
    [nav, "maxTouchPoints", Object.getOwnPropertyDescriptor(nav, "maxTouchPoints")],
  ];
  Object.defineProperty(nav, "userAgent", { get: () => ua, configurable: true });
  Object.defineProperty(nav, "maxTouchPoints", { get: () => touch, configurable: true });
  if (typeof width === "number") {
    originals.push([window, "innerWidth", Object.getOwnPropertyDescriptor(window, "innerWidth")]);
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  }
  DETECTOR_RESTORE.push(() => {
    for (const [obj, key, desc] of originals) {
      if (desc) Object.defineProperty(obj, key, desc);
      else delete (obj as Record<string, unknown>)[key];
    }
  });
}
afterEach(() => {
  while (DETECTOR_RESTORE.length) DETECTOR_RESTORE.pop()!();
});

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// jsdom forbids cross-origin replaceState, so swap the whole location
// object for hostname-driven cases (restored by DETECTOR_RESTORE).
function stubHostname(hostname: string) {
  const w = window as unknown as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(w, "location");
  delete w.location;
  w.location = { hostname };
  DETECTOR_RESTORE.push(() => {
    delete w.location;
    if (original) Object.defineProperty(w, "location", original);
  });
}

it("classifies an iPhone user agent as phone", () => {
  stubDeviceEnv({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1" });
  expect(detectOwnerDevice()).toBe("phone");
});

it("classifies an Android mobile user agent as phone", () => {
  stubDeviceEnv({ ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36" });
  expect(detectOwnerDevice()).toBe("phone");
});

it("classifies an iPad user agent as ipad", () => {
  stubDeviceEnv({ ua: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1" });
  expect(detectOwnerDevice()).toBe("ipad");
});

it("classifies desktop-mode iPad (Macintosh UA + touch, iPad-sized) as ipad", () => {
  stubDeviceEnv({ ua: MAC_UA, touch: 5, width: 1024 });
  expect(detectOwnerDevice()).toBe("ipad");
});

it("classifies a narrow viewport as phone", () => {
  stubDeviceEnv({ ua: MAC_UA, width: 390 });
  expect(detectOwnerDevice()).toBe("phone");
});

it("classifies a desktop browser off the Studio host as laptop", () => {
  stubDeviceEnv({ ua: MAC_UA, width: 1728 });
  stubHostname("studio.lan");
  expect(detectOwnerDevice()).toBe("laptop");
});

it("classifies a desktop browser on a loopback origin as studio", () => {
  stubDeviceEnv({ ua: MAC_UA, width: 1728 });
  stubHostname("127.0.0.1");
  expect(detectOwnerDevice()).toBe("studio");
});

it("tags every outbound run with the detected owner device", async () => {
  // deep-link send exercises our own runAgent call — the tag must ride
  // the run body no matter which path fires it
  stubDeviceEnv({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1" });
  window.history.replaceState({}, "", "/cockpit/honey?q=hello%20from%20the%20phone");
  const { fn, runPayloads } = mockFetch(null, {});
  vi.stubGlobal("fetch", fn);

  chat();

  await waitFor(() => expect(runPayloads.length).toBeGreaterThan(0));
  expect(runPayloads[0]?.forwardedProps).toMatchObject({ device: "phone" });
  window.history.replaceState({}, "", "/");
});

// --- Visual pointer (kanban/device-input-matrix slice 2, 2026-10-18) ---
// The adapter strips the VISUAL machine line from the reply and parks
// the parsed pointer on RUN_FINISHED's result; the chat surface
// republishes it to the pointing sidebar (slot + window event). A null
// pointer CLEARS the slot — the latest reply pointed at nothing.

const SLOT_KEY = "cockpit.visual.honey";

it("publishes the run's visual pointer to the sidebar slot", async () => {
  window.history.replaceState({}, "", "/cockpit/honey?q=show%20me%20the%20map");
  const { fn } = mockFetch(null, {}, {
    kind: "map",
    path: "Vision/Agent Visuals/example.excalidraw.md",
  });
  vi.stubGlobal("fetch", fn);

  const seen: { agent?: string; visual?: unknown }[] = [];
  const onVisual = (e: Event) => {
    seen.push((e as CustomEvent<{ agent?: string; visual?: unknown }>).detail);
  };
  window.addEventListener("cockpit-visual", onVisual);
  chat();

  await waitFor(() =>
    expect(window.localStorage.getItem(SLOT_KEY)).toBe(
      JSON.stringify({
        kind: "map",
        path: "Vision/Agent Visuals/example.excalidraw.md",
      }),
    ),
  );
  expect(seen.at(-1)).toEqual({
    agent: "honey",
    visual: { kind: "map", path: "Vision/Agent Visuals/example.excalidraw.md" },
  });
  window.removeEventListener("cockpit-visual", onVisual);
  window.history.replaceState({}, "", "/");
});

it("clears the slot when the run points at nothing", async () => {
  window.localStorage.setItem(
    SLOT_KEY,
    JSON.stringify({ kind: "plex", path: "K-Plex/Mind Map.md" }),
  );
  window.history.replaceState({}, "", "/cockpit/honey?q=plain%20answer");
  const { fn } = mockFetch(null, {}); // RUN_FINISHED carries visual:null
  vi.stubGlobal("fetch", fn);

  chat();

  await waitFor(() => expect(window.localStorage.getItem(SLOT_KEY)).toBeNull());
  window.history.replaceState({}, "", "/");
});

it("restores the last reply's pointer from the thread transcript", async () => {
  // remount after tab discard: the transcript's LAST assistant turn
  // carries the visual the adapter recorded — the sidebar re-points
  window.localStorage.setItem(PIN_KEY, "web-vis");
  const { fn } = mockFetch("web-vis", {
    "web-vis": [
      { role: "user", content: "where is it?" },
      {
        role: "assistant",
        content: "It is here.",
        visual: { kind: "file", path: "kanban/device-input-matrix.md" },
      },
    ],
  });
  vi.stubGlobal("fetch", fn);

  chat();

  await waitFor(() =>
    expect(window.localStorage.getItem(SLOT_KEY)).toBe(
      JSON.stringify({ kind: "file", path: "kanban/device-input-matrix.md" }),
    ),
  );
});

it("restore clears the slot when the last reply had no pointer", async () => {
  window.localStorage.setItem(
    SLOT_KEY,
    JSON.stringify({ kind: "map", path: "old.excalidraw.md" }),
  );
  window.localStorage.setItem(PIN_KEY, "web-plain");
  const { fn } = mockFetch("web-plain", {
    "web-plain": [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello, no artifact involved" },
    ],
  });
  vi.stubGlobal("fetch", fn);

  chat();

  await waitFor(() => expect(window.localStorage.getItem(SLOT_KEY)).toBeNull());
});

// --- Device override (owner refinement 2026-10-18: loopback misfire) ---
// The heuristic guesses; the owner pins. A pinned override beats every
// heuristic signal; no pin (or a corrupt one) falls back to the guess;
// the chip's pin rides the next run's forwardedProps.device.

const OVERRIDE_KEY = "owner-device-override";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

it("a pinned override beats the heuristic guess", () => {
  // UA says phone loudly; the pin says laptop — the pin wins
  stubDeviceEnv({ ua: IPHONE_UA });
  window.localStorage.setItem(OVERRIDE_KEY, "laptop");
  expect(detectOwnerDevice()).toBe("laptop");
});

it("no override falls back to the heuristic", () => {
  stubDeviceEnv({ ua: IPHONE_UA });
  expect(detectOwnerDevice()).toBe("phone");
});

it("a corrupt override is ignored, not trusted", () => {
  stubDeviceEnv({ ua: IPHONE_UA });
  window.localStorage.setItem(OVERRIDE_KEY, "toaster");
  expect(detectOwnerDevice()).toBe("phone");
});

it("the chip pins the device and the next mount's runs carry the pinned tag", async () => {
  // the exact 2026-10-18 misfire shape: desktop browser on a loopback
  // origin — heuristic says studio while the owner sits at his laptop
  stubDeviceEnv({ ua: MAC_UA, width: 1728 });
  stubHostname("127.0.0.1");
  const first = mockFetch(null, {});
  vi.stubGlobal("fetch", first.fn);

  const { getByRole, unmount } = chat();

  // the chip shows what the engine currently believes: the studio guess
  const chip = getByRole("button", { name: /owner device/i });
  expect(chip).toHaveTextContent("studio");

  // pin the truth through the picker
  fireEvent.click(chip);
  fireEvent.click(getByRole("menuitemradio", { name: /^laptop$/ }));
  expect(window.localStorage.getItem(OVERRIDE_KEY)).toBe("laptop");
  // same mount, the chip now shows the pinned tag
  expect(getByRole("button", { name: /owner device/i })).toHaveTextContent(
    "laptop",
  );
  unmount();
  cleanup();

  // fresh mount, same loopback shape: the run body carries the pin
  window.history.replaceState({}, "", "/cockpit/honey?q=from%20the%20laptop");
  const second = mockFetch(null, {});
  vi.stubGlobal("fetch", second.fn);
  chat();

  await waitFor(() => expect(second.runPayloads.length).toBeGreaterThan(0));
  expect(second.runPayloads[0]?.forwardedProps).toMatchObject({
    device: "laptop",
    deviceSource: "pin",
  });
  window.history.replaceState({}, "", "/");
});

it("sources the tag so the adapter can tell pin from guess", async () => {
  // server-side classification (owner hit #3): the runtime edge stamps
  // the browser's real peer on the run; the client tag survives as a
  // SOURCED payload — "heuristic" is advisory (server signals outrank
  // it), "pin" is the owner's word and beats everything
  stubDeviceEnv({ ua: MAC_UA, width: 1728 });
  stubHostname("127.0.0.1"); // the exact misfire shape: heuristic says studio
  window.history.replaceState({}, "", "/cockpit/honey?q=hi");
  const first = mockFetch(null, {});
  vi.stubGlobal("fetch", first.fn);
  chat();

  await waitFor(() => expect(first.runPayloads.length).toBeGreaterThan(0));
  expect(first.runPayloads[0]?.forwardedProps).toMatchObject({
    device: "studio",
    deviceSource: "heuristic",
  });
  window.history.replaceState({}, "", "/");

  window.localStorage.setItem(OVERRIDE_KEY, "laptop");
  window.history.replaceState({}, "", "/cockpit/honey?q=again");
  const second = mockFetch(null, {});
  vi.stubGlobal("fetch", second.fn);
  chat();

  await waitFor(() => expect(second.runPayloads.length).toBeGreaterThan(0));
  expect(second.runPayloads[0]?.forwardedProps).toMatchObject({
    device: "laptop",
    deviceSource: "pin",
  });
  window.history.replaceState({}, "", "/");
});
