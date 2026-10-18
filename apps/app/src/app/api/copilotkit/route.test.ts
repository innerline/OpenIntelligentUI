// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

// Server-side owner-device classification (kanban/device-input-matrix,
// owner hit #3, 2026-10-18): THIS route is the only hop that sees the
// browser's real address — the adapter hop beyond it is localhost by
// construction. The test pins the capture→forward chain: the request's
// x-forwarded-for / user-agent flow into the runtime options the
// runtime's cockpit agents carry, where PeerTaggedHttpAgent stamps them
// onto every proxied AG-UI run (unit-pinned in
// copilotkit-runtime-options.test.ts).

vi.mock("@copilotkit/runtime", () => ({
  CopilotRuntime: vi.fn(),
  ExperimentalEmptyAdapter: vi.fn(),
  copilotRuntimeNextJSAppRouterEndpoint: vi.fn(() => ({
    handleRequest: vi.fn(async () => new Response("ok")),
  })),
}));

import { POST } from "./route";
import { CopilotRuntime } from "@copilotkit/runtime";
import { NextRequest } from "next/server";
import type { RunAgentInput } from "@ag-ui/client";

const runtimeOptions = () =>
  (CopilotRuntime as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];

// requestInit is protected by design; the test drives the documented
// hook through the agent the route actually constructed.
function stampedPropsOf(runtime: { agents: Record<string, unknown> }): Record<string, unknown> {
  const agent = runtime.agents.honey as {
    requestInit(input: RunAgentInput): RequestInit;
  };
  const init = agent.requestInit({
    threadId: "t1",
    forwardedProps: { device: "studio", deviceSource: "heuristic" },
  } as unknown as RunAgentInput);
  return JSON.parse(init.body as string).forwardedProps;
}

beforeEach(() => {
  (CopilotRuntime as unknown as ReturnType<typeof vi.fn>).mockClear();
});

describe("/api/copilotkit peer capture", () => {
  it("captures the browser's peer address and user agent and forwards them onto proxied runs", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/copilotkit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "100.127.208.46",
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    // the full chain: request header → captured at the edge → the
    // runtime's cockpit agent stamps it on the proxied AG-UI run
    const props = stampedPropsOf(runtimeOptions());
    expect(props.devicePeer).toBe("100.127.208.46");
    expect(props.deviceUserAgent).toContain("Macintosh");
    expect(props.device).toBe("studio"); // client payload rides alongside
  });

  it("stamps nothing when no peer address is visible", async () => {
    await POST(
      new NextRequest("http://localhost/api/copilotkit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    const props = stampedPropsOf(runtimeOptions());
    expect(props).not.toHaveProperty("devicePeer");
    expect(props).not.toHaveProperty("deviceUserAgent");
  });
});
