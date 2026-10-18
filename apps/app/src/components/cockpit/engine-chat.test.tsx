import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Providers } from "@/app/providers";
import { EngineChat } from "@/components/cockpit/engine-chat";

// Cross-device rejoin (kanban/cockpit-thread-continuity, 2026-10-18):
// the localStorage pin is per browser, so each device minted its own
// thread. On mount the chat asks /api/cockpit/thread-current for the
// persona's anchor (the adapter's most recently active thread) and adopts
// it while still idle — re-pinning localStorage and restoring the anchor
// thread's history instead of forking a parallel conversation.

const PIN_KEY = "cockpit.thread.honey";

// Same shape as shared-thread.test.tsx's mockRuntime: keep the real SDK
// providers/agent internals, replace only the HTTP boundary.
function mockFetch(anchor: string | null, transcripts: Record<string, unknown>) {
  const threadFetches: string[] = [];
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
  return { fn, threadFetches };
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
