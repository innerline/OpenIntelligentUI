import { describe, it, expect } from "vitest";
import { LangGraphHttpAgent } from "@copilotkit/runtime/langgraph";
import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import {
  buildRuntimeOptions,
  extractClientPeer,
  HONEY_AGUI_URL,
  LARRY_AGUI_URL,
} from "../copilotkit-runtime-options";

describe("buildRuntimeOptions", () => {
  it("isolates credentials between runtime instances", () => {
    const first = buildRuntimeOptions({ providerHeaders: { "x-openai-api-key": "first", "x-jev-api-key": "first-jev" } });
    const second = buildRuntimeOptions({ providerHeaders: { "x-openai-api-key": "second", "x-jev-api-key": "second-jev" } });
    expect(first.agents.default.headers["x-openai-api-key"]).toBe("first");
    expect(second.agents.default.headers["x-openai-api-key"]).toBe("second");
    expect(buildRuntimeOptions({}).agents.default.headers).not.toHaveProperty("x-openai-api-key");
  });

  it("enables openGenerativeUI", () => {
    expect(buildRuntimeOptions({}).openGenerativeUI).toBe(true);
  });

  it("defines a default LangGraph agent", () => {
    const options = buildRuntimeOptions({});
    expect(options.agents.default).toBeInstanceOf(LangGraphHttpAgent);
  });

  it("defaults the agent url to http://localhost:8123", () => {
    const options = buildRuntimeOptions({});
    expect(options.agents.default.url).toBe("http://localhost:8123");
  });

  it("registers the cockpit engine agents against the studio adapters", () => {
    const options = buildRuntimeOptions({});
    expect(options.agents.honey).toBeInstanceOf(HttpAgent);
    expect(options.agents.larry).toBeInstanceOf(HttpAgent);
    expect(options.agents.honey.url).toBe(HONEY_AGUI_URL);
    expect(options.agents.larry.url).toBe(LARRY_AGUI_URL);
    expect(HONEY_AGUI_URL).toBe("http://127.0.0.1:8126/");
    expect(LARRY_AGUI_URL).toBe("http://127.0.0.1:8127/");
  });

  it("keeps provider keys off the cockpit engine agents", () => {
    // The adapters hold their own model keys; browser keys must not leak into them.
    const options = buildRuntimeOptions({
      providerHeaders: { "x-openai-api-key": "secret" },
    });
    expect(options.agents.default.headers["x-openai-api-key"]).toBe("secret");
    expect(options.agents.honey.headers).not.toHaveProperty("x-openai-api-key");
    expect(options.agents.larry.headers).not.toHaveProperty("x-openai-api-key");
  });

  it("prefixes bare host:port urls with http://", () => {
    const options = buildRuntimeOptions({ langgraphUrl: "agent-host:8123" });
    expect(options.agents.default.url).toBe("http://agent-host:8123");
  });

  it("preserves full urls as-is", () => {
    const options = buildRuntimeOptions({ langgraphUrl: "https://agent.example.com" });
    expect(options.agents.default.url).toBe("https://agent.example.com");
  });

  it("preserves the a2ui config", () => {
    expect(buildRuntimeOptions({}).a2ui).toEqual({ injectA2UITool: true });
  });

  it("omits mcpApps when mcpServerUrl is unset", () => {
    expect(buildRuntimeOptions({}).mcpApps).toBeUndefined();
  });

  it("includes mcpApps when mcpServerUrl is set", () => {
    const options = buildRuntimeOptions({ mcpServerUrl: "http://localhost:5001/mcp" });
    expect(options.mcpApps).toEqual({
      servers: [{
        type: "http",
        url: "http://localhost:5001/mcp",
        serverId: "example_mcp_app",
      }],
    });
  });
});

// --- Server-side device classification (kanban/device-input-matrix,
// owner hit #3, 2026-10-18): the runtime edge stamps the browser's real
// peer address + User-Agent onto every proxied AG-UI run so the
// adapters can classify the desk — a browser cannot tell the desks
// apart; the connecting machine's address can.

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

function runInput(): RunAgentInput {
  return {
    threadId: "t1",
    runId: "r1",
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: { device: "studio", deviceSource: "heuristic" },
  } as unknown as RunAgentInput;
}

// requestInit is protected by design; the test drives the documented
// hook through the subclass contract.
function requestInitOf(agent: HttpAgent, input: RunAgentInput): RequestInit {
  return (agent as unknown as {
    requestInit(input: RunAgentInput): RequestInit;
  }).requestInit(input);
}

function forwardedPropsOf(init: RequestInit): Record<string, unknown> {
  expect(init.method).toBe("POST");
  return JSON.parse(init.body as string).forwardedProps;
}

describe("server-side device context stamping", () => {
  it("stamps the browser's peer address and user agent on every cockpit agent run", () => {
    const options = buildRuntimeOptions({
      clientPeer: "100.127.208.46",
      clientUserAgent: MAC_UA,
    });
    for (const agent of [options.agents.honey, options.agents.larry]) {
      expect(agent).toBeInstanceOf(HttpAgent);
      const props = forwardedPropsOf(requestInitOf(agent, runInput()));
      expect(props.devicePeer).toBe("100.127.208.46");
      expect(props.deviceUserAgent).toBe(MAC_UA);
      // the client's own (sourced) tag rides alongside, untouched
      expect(props.device).toBe("studio");
      expect(props.deviceSource).toBe("heuristic");
    }
  });

  it("stamps nothing when the server could not see the browser", () => {
    const options = buildRuntimeOptions({});
    for (const agent of [options.agents.honey, options.agents.larry]) {
      const props = forwardedPropsOf(requestInitOf(agent, runInput()));
      expect(props).not.toHaveProperty("devicePeer");
      expect(props).not.toHaveProperty("deviceUserAgent");
      expect(props.device).toBe("studio"); // the client payload passes through
    }
  });

  it("stamps the peer alone when no user agent is available", () => {
    const options = buildRuntimeOptions({ clientPeer: "192.168.1.55" });
    const props = forwardedPropsOf(requestInitOf(options.agents.honey, runInput()));
    expect(props.devicePeer).toBe("192.168.1.55");
    expect(props).not.toHaveProperty("deviceUserAgent");
  });

  it("preserves a forwardedProps-free run (creates the object safely)", () => {
    const options = buildRuntimeOptions({ clientPeer: "100.127.208.46" });
    const input = runInput();
    delete (input as { forwardedProps?: unknown }).forwardedProps;
    const props = forwardedPropsOf(requestInitOf(options.agents.honey, input));
    expect(props.devicePeer).toBe("100.127.208.46");
  });

  // The runtime clones the registered agent per proxied run
  // (ProxiedCopilotRuntimeAgent.clone -> delegate.clone()); @ag-ui's
  // clone never calls the subclass constructor, so the peer/UA payload
  // must be carried across explicitly — an un-maintained clone died in
  // requestInit reading `.peer` of undefined (RUN_ERROR, run never left
  // the runtime; found live 2026-10-19).
  it("stamps the clone too — the runtime runs a CLONE of the registered agent", () => {
    const options = buildRuntimeOptions({
      clientPeer: "100.127.208.46",
      clientUserAgent: MAC_UA,
    });
    const clone = options.agents.honey.clone() as HttpAgent;
    expect(clone).not.toBe(options.agents.honey);
    const props = forwardedPropsOf(requestInitOf(clone, runInput()));
    expect(props.devicePeer).toBe("100.127.208.46");
    expect(props.deviceUserAgent).toBe(MAC_UA);
  });
});

describe("extractClientPeer", () => {
  it("reads the connecting machine's address from x-forwarded-for", () => {
    expect(
      extractClientPeer(new Headers({ "x-forwarded-for": "100.127.208.46" })),
    ).toBe("100.127.208.46");
  });

  it("takes the first entry of a proxy chain", () => {
    expect(
      extractClientPeer(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })),
    ).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip, then null", () => {
    expect(extractClientPeer(new Headers({ "x-real-ip": "100.127.208.46" }))).toBe(
      "100.127.208.46",
    );
    expect(extractClientPeer(new Headers())).toBeNull();
    expect(
      extractClientPeer(new Headers({ "x-forwarded-for": "  " })),
    ).toBeNull();
  });
});
