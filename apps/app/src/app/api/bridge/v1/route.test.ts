// @vitest-environment node
import { describe, expect, it } from "vitest";

// The bare base ping (GET /api/bridge/v1) — some OpenAI-shaped clients
// probe the configured base itself before/alongside model discovery.
// Deliberately open: these tests make requests with NO token at all and
// still expect the 200 identity payload.

import { GET, OPTIONS } from "./route";

describe("bare base ping", () => {
  it("answers 200 with the service identity and model names, no token asked", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({
      status: "ok",
      service: "honey-larry-bridge",
      models: ["honey", "larry"],
    });
  });

  it("answers OPTIONS preflight with permissive CORS", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});
