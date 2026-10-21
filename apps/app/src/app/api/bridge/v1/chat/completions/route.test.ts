// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// K5 contract pin (kanban/unified-honey): the Copilot Plus bridge is
// the SAME unified run lane as /api/cockpit/honey, dressed in the
// OpenAI Chat Completions wire shape. Mocked heavy module keeps the
// lane URLs deterministic; extractClientPeer is a faithful copy of the
// 5-line original (unit-tested where it lives, in
// copilotkit-runtime-options).
vi.mock("@/lib/copilotkit-runtime-options", () => ({
  HONEY_AGUI_URL: "http://honey-test/",
  LARRY_AGUI_URL: "http://larry-test/",
  extractClientPeer: (headers: Headers): string | null => {
    const forwarded = headers.get("x-forwarded-for");
    const first = forwarded?.split(",")[0]?.trim();
    if (first) return first;
    return headers.get("x-real-ip")?.trim() || null;
  },
}));

import { GET, OPTIONS, POST } from "./route";
import fs from "fs";
import os from "os";
import path from "path";

const TOKEN = "test-stack-token-1234";

let tokenFile: string;
let runCalls: { url: string; body: Record<string, unknown> }[] = [];

// Lane fetch: /thread/current answers an anchor; the run POST records
// its body and answers a one-delta SSE reply.
function laneFetch(reply = "the lane reply") {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/thread/current")) {
      return Response.json({ threadId: "anchor-thread-1" });
    }
    const raw =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.text()
          : "{}";
    runCalls.push({ url, body: JSON.parse(raw) });
    return new Response(
      `data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: reply })}\n\n` +
        `data: ${JSON.stringify({ type: "RUN_FINISHED" })}\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  });
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("http://localhost/api/bridge/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const honeyBody = (messages: unknown, extra: Record<string, unknown> = {}) => ({
  model: "honey",
  messages,
  ...extra,
});

beforeEach(() => {
  tokenFile = path.join(os.tmpdir(), `mwp-bridge-token-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tokenFile, `${TOKEN}\n`);
  vi.stubEnv("MWP_STACK_TOKEN_FILE", tokenFile);
  runCalls = [];
  vi.stubGlobal("fetch", laneFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(tokenFile, { force: true });
});

describe("model routing — switching model = switching persona", () => {
  it("routes honey to the honey adapter on the unified lane", async () => {
    const res = await post(honeyBody([{ role: "user", content: "hi honey" }]));
    expect(res.status).toBe(200);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].url).toBe("http://honey-test/");
    const sent = runCalls[0].body;
    expect(sent.threadId).toBe("anchor-thread-1"); // thread ADOPTED, never minted
    expect((sent.messages as unknown[])).toHaveLength(1);
  });

  it("routes larry to the larry adapter (same lane shape)", async () => {
    const res = await post({ model: "larry", messages: [{ role: "user", content: "hi larry" }] });
    expect(res.status).toBe(200);
    expect(runCalls[0].url).toBe("http://larry-test/");
  });

  it("tags the run with the copilot-plus door and the caller's real signals", async () => {
    await post(honeyBody([{ role: "user", content: "hi" }]), {
      "x-forwarded-for": "100.127.208.46",
      "user-agent": "Mozilla/5.0 (Macintosh; Obsidian)",
    });
    const fp = runCalls[0].body.forwardedProps as Record<string, unknown>;
    expect(fp.device).toBe("obsidian");
    expect(fp.deviceSource).toBe("pin");
    expect(fp.surface).toBe("copilot-plus");
    expect(fp.devicePeer).toBe("100.127.208.46"); // cockpit-edge stamping, mirrored
    expect(fp.deviceUserAgent).toContain("Obsidian");
  });

  it("rejects unknown models with the two valid names", async () => {
    const res = await post({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('"honey"');
    expect(body.error.message).toContain('"larry"');
  });
});

describe("prompt extraction — persona integrity", () => {
  it("forwards ONLY the last user message, ignoring system prompts and history", async () => {
    await post(
      honeyBody([
        { role: "system", content: "You are Obsidian's own assistant prompt" },
        { role: "user", content: "earlier question, already in the unified session" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "the newest question" },
      ]),
    );
    const sent = runCalls[0].body;
    const msgs = sent.messages as { role: string; content: string }[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("the newest question");
  });

  it("joins multimodal content parts into text", async () => {
    await post(
      honeyBody([
        {
          role: "user",
          content: [
            { type: "text", text: "part one " },
            { type: "image_url", image_url: { url: "file://x" } },
            { type: "text", text: "part two" },
          ],
        },
      ]),
    );
    const msgs = runCalls[0].body.messages as { content: string }[];
    expect(msgs[0].content).toBe("part one part two");
  });

  it("rejects a chat with no user message", async () => {
    const res = await post(honeyBody([{ role: "system", content: "only system" }]));
    expect(res.status).toBe(400);
    expect(runCalls).toHaveLength(0);
  });

  it("rejects a user message whose text is empty", async () => {
    const res = await post(honeyBody([{ role: "user", content: "   " }]));
    expect(res.status).toBe(400);
  });

  it("rejects a non-JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/bridge/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("OpenAI response shape", () => {
  it("answers a well-formed chat.completion", async () => {
    const res = await post(honeyBody([{ role: "user", content: "hello there" }]));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      id: string;
      object: string;
      model: string;
      choices: { index: number; message: { role: string; content: string }; finish_reason: string }[];
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("honey");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].index).toBe(0);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("the lane reply");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBe(
      body.usage.prompt_tokens + body.usage.completion_tokens,
    );
  });

  it("answers stream:true as a minimal OpenAI SSE chunk stream", async () => {
    const res = await post(
      honeyBody([{ role: "user", content: "stream me" }], { stream: true }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const raw = await res.text();
    expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const chunks = raw
      .split("\n\n")
      .filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.replace(/^data:\s*/, "")));
    for (const c of chunks) {
      expect(c.object).toBe("chat.completion.chunk");
      expect(c.model).toBe("honey");
    }
    const deltas = chunks.flatMap((c) => c.choices.map((ch: { delta: unknown }) => ch.delta));
    expect(deltas).toEqual([
      { role: "assistant" },
      { content: "the lane reply" },
      {},
    ]);
    const finishes = chunks.flatMap((c) => c.choices.map((ch: { finish_reason: unknown }) => ch.finish_reason));
    expect(finishes).toEqual([null, null, "stop"]);
  });

  it("answers a lane failure as a 502 OpenAI error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/thread/current")) return Response.json({ threadId: "a" });
        return new Response(
          `data: ${JSON.stringify({ type: "RUN_ERROR", message: "engine exploded" })}\n\n`,
          { status: 200 },
        );
      }),
    );
    const res = await post(honeyBody([{ role: "user", content: "hi" }]));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.message).toBe("engine exploded");
    expect(body.error.type).toBe("api_error");
  });
});

describe("auth matrix — platform token doors", () => {
  it("rides the sibling posture when no token is presented", async () => {
    const res = await post(honeyBody([{ role: "user", content: "hi" }]));
    expect(res.status).toBe(200);
  });

  it("accepts the platform token as Authorization: Bearer (the Copilot Plus key field)", async () => {
    const res = await post(honeyBody([{ role: "user", content: "hi" }]), {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(200);
  });

  it("accepts the token via x-mwp-token and ?token=", async () => {
    const viaHeader = await post(honeyBody([{ role: "user", content: "hi" }]), {
      "x-mwp-token": TOKEN,
    });
    expect(viaHeader.status).toBe(200);
    const viaQuery = await POST(
      new Request(
        `http://localhost/api/bridge/v1/chat/completions?token=${encodeURIComponent(TOKEN)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(honeyBody([{ role: "user", content: "hi" }])),
        },
      ),
    );
    expect(viaQuery.status).toBe(200);
  });

  it("rejects a wrong Bearer token", async () => {
    const res = await post(honeyBody([{ role: "user", content: "hi" }]), {
      authorization: "Bearer wrong-token",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong ?token= and wrong x-mwp-token", async () => {
    const viaQuery = await POST(
      new Request("http://localhost/api/bridge/v1/chat/completions?token=nope", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(honeyBody([{ role: "user", content: "hi" }])),
      }),
    );
    expect(viaQuery.status).toBe(401);
    const viaHeader = await post(honeyBody([{ role: "user", content: "hi" }]), {
      "x-mwp-token": "nope",
    });
    expect(viaHeader.status).toBe(401);
  });

  it("503s when a token is presented but the stack token file is unreadable", async () => {
    vi.stubEnv("MWP_STACK_TOKEN_FILE", "/nonexistent/mwp/token");
    const res = await post(honeyBody([{ role: "user", content: "hi" }]), {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(503);
  });
});

describe("CORS — the Obsidian renderer origin", () => {
  it("answers OPTIONS preflight with permissive CORS", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("carries ACAO:* on POST answers, errors included", async () => {
    const ok = await post(honeyBody([{ role: "user", content: "hi" }]));
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    const bad = await post({ model: "nope", messages: [] });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("carries ACAO:* on the GET contract ping", async () => {
    const res = await GET(
      new Request("http://localhost/api/bridge/v1/chat/completions"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { usage: { copilot_plus_setup: { base_url: string } } };
    expect(body.usage.copilot_plus_setup.base_url).toContain("/api/bridge/v1");
  });
});
