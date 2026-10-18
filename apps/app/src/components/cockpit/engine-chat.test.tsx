import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
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
// kanban/device-input-matrix).
function mockFetch(anchor: string | null, transcripts: Record<string, unknown>) {
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
      { type: "RUN_FINISHED", threadId: payload.threadId, runId: payload.runId },
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
