// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The discovery door the Obsidian Copilot Plus plugin validates custom
// models with (GET {base}/models — the call whose 404 rejected the
// owner's honey/larry setup on 2026-10-23). Pins the OpenAI list shape,
// the fail-invisible auth matrix, and the CORS the renderer fetch needs.
// No fetch mock needed: unlike chat/completions, this route talks to no
// adapter — it only reads the stack token file (seam-stubbed below).

import { GET, OPTIONS } from "./route";
import fs from "fs";
import os from "os";
import path from "path";

const TOKEN = "test-stack-token-1234";
// 2026-10-21T00:00:00Z — the day the K5 bridge landed (bridge-shared).
const FIXED_EPOCH = 1_792_540_800;

let tokenFile: string;

function get(url: string, headers: Record<string, string> = {}) {
  return GET(new Request(url, { headers }));
}

const goodUrl = `http://localhost/api/bridge/v1/models?token=${encodeURIComponent(TOKEN)}`;

beforeEach(() => {
  tokenFile = path.join(
    os.tmpdir(),
    `mwp-models-token-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(tokenFile, `${TOKEN}\n`);
  vi.stubEnv("MWP_STACK_TOKEN_FILE", tokenFile);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tokenFile, { force: true });
});

describe("models list — the OpenAI discovery shape", () => {
  it("answers the OpenAI list shape with exactly honey and larry", async () => {
    const res = await get(goodUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { object: string; data: unknown[] };
    expect(body.object).toBe("list");
    expect(body.data).toEqual([
      { id: "honey", object: "model", created: FIXED_EPOCH, owned_by: "mwp" },
      { id: "larry", object: "model", created: FIXED_EPOCH, owned_by: "mwp" },
    ]);
  });

  it("carries ACAO:* — the Obsidian renderer fetch must not be CORS-blocked", async () => {
    const res = await get(goodUrl);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("auth matrix — fail invisible, never 401-loud", () => {
  it("accepts the platform token as Authorization: Bearer (the Copilot Plus key field)", async () => {
    const res = await get("http://localhost/api/bridge/v1/models", {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(200);
  });

  it("accepts the token via x-mwp-token", async () => {
    const res = await get("http://localhost/api/bridge/v1/models", {
      "x-mwp-token": TOKEN,
    });
    expect(res.status).toBe(200);
  });

  it("answers 404 when no token is presented at all", async () => {
    const res = await get("http://localhost/api/bridge/v1/models");
    expect(res.status).toBe(404);
  });

  it("answers 404 for a wrong Bearer token", async () => {
    const res = await get("http://localhost/api/bridge/v1/models", {
      authorization: "Bearer wrong-token",
    });
    expect(res.status).toBe(404);
  });

  it("answers 404 for a wrong ?token= and a wrong x-mwp-token", async () => {
    const viaQuery = await get("http://localhost/api/bridge/v1/models?token=nope");
    expect(viaQuery.status).toBe(404);
    const viaHeader = await get("http://localhost/api/bridge/v1/models", {
      "x-mwp-token": "nope",
    });
    expect(viaHeader.status).toBe(404);
  });

  it("answers 404 (not 503) when a token is presented but the stack token file is unreadable", async () => {
    vi.stubEnv("MWP_STACK_TOKEN_FILE", "/nonexistent/mwp/token");
    const res = await get("http://localhost/api/bridge/v1/models", {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(404);
  });

  it("leaks nothing on 404 — no model names, no service identity", async () => {
    const res = await get("http://localhost/api/bridge/v1/models?token=nope");
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain("honey");
    expect(raw).not.toContain("larry");
    expect(raw).not.toContain("bridge");
  });
});

describe("CORS preflight — the Obsidian renderer origin", () => {
  it("answers OPTIONS preflight with permissive CORS", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });
});
