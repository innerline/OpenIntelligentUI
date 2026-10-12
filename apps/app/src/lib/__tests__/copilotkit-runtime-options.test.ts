import { describe, it, expect } from "vitest";
import { LangGraphHttpAgent } from "@copilotkit/runtime/langgraph";
import { HttpAgent } from "@ag-ui/client";
import { buildRuntimeOptions, HONEY_AGUI_URL, LARRY_AGUI_URL } from "../copilotkit-runtime-options";

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
