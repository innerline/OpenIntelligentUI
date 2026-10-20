import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// The iOS Honey Shortcut route (POST/GET /api/cockpit/honey — kanban
// device-input-matrix, owner directive 2026-10-20). The adapter run
// lane (global fetch) and the voice render lib are mocked; the auth
// seam (MWP_STACK_TOKEN_FILE) points at a scratch token file. Nothing
// here touches the real adapter, engine, or runtime/.

const ADAPTER = "http://127.0.0.1:8126/";
const ORIGIN = "http://100.81.213.106:3210";
const TOKEN = "test-stack-token";

const hoisted = vi.hoisted(() => ({
  renderCalls: [] as string[],
  failRender: false,
  renderHash: "ab".repeat(32),
  anchorThread: "anchor-thread-1" as string | null, // null → probe fails
  failAnchorStatus: 0, // non-zero → probe answers this status
  failRun: false, // POST to the adapter throws
  runStatus: 200, // non-200 → adapter answers this without SSE
  runError: null as string | null, // RUN_ERROR message
  runText: "Hello from Honey, spoken reply ready." as string | null, // null → no text events
  runBodies: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/copilotkit-runtime-options", () => ({
  HONEY_AGUI_URL: "http://127.0.0.1:8126/",
}));

vi.mock("@/lib/voice-render", () => ({
  renderVoiceFile: async (text: string) => {
    hoisted.renderCalls.push(text);
    if (hoisted.failRender) throw new Error("render exploded");
    return {
      hash: hoisted.renderHash,
      file: `/x/${hoisted.renderHash}.m4a`,
      cached: false,
      voice: "piper:en_US-amy-medium",
    };
  },
}));

function sse(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function okRun(text: string): string {
  const mid = Math.floor(text.length / 2);
  return (
    sse({ type: "RUN_STARTED", threadId: "anchor-thread-1", runId: "r1" }) +
    ": keep-alive comment the parser must ignore\n\n" +
    "data: not-json-at-all\n\n" +
    sse({ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" }) +
    sse({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: text.slice(0, mid) }) +
    sse({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: text.slice(mid) }) +
    sse({ type: "TEXT_MESSAGE_END", messageId: "m1" }) +
    sse({ type: "RUN_FINISHED", threadId: "anchor-thread-1", runId: "r1" })
  );
}

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `${ADAPTER}thread/current`) {
      if (hoisted.anchorThread === null && hoisted.failAnchorStatus === 0) {
        throw new Error("adapter unreachable");
      }
      if (hoisted.failAnchorStatus !== 0) {
        return new Response("nope", { status: hoisted.failAnchorStatus });
      }
      return Response.json({ threadId: hoisted.anchorThread, agent: "honey" });
    }
    if (url === ADAPTER && init?.method === "POST") {
      if (hoisted.failRun) throw new Error("connection refused");
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      hoisted.runBodies.push(body);
      if (hoisted.runStatus !== 200) {
        return new Response("adapter blew up", { status: hoisted.runStatus });
      }
      const payload = hoisted.runError
        ? sse({ type: "RUN_ERROR", runId: "r1", message: hoisted.runError })
        : hoisted.runText === null
          ? sse({ type: "RUN_STARTED", runId: "r1" }) +
            sse({ type: "RUN_FINISHED", runId: "r1" })
          : okRun(hoisted.runText);
      return new Response(payload, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }),
);

import { GET, POST } from "@/app/api/cockpit/honey/route";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "honey-shortcut-test-"));

beforeEach(() => {
  process.env.MWP_STACK_TOKEN_FILE = path.join(scratch, "token");
  fs.writeFileSync(path.join(scratch, "token"), `${TOKEN}\n`);
  hoisted.renderCalls.length = 0;
  hoisted.failRender = false;
  hoisted.anchorThread = "anchor-thread-1";
  hoisted.failAnchorStatus = 0;
  hoisted.failRun = false;
  hoisted.runStatus = 200;
  hoisted.runError = null;
  hoisted.runText = "Hello from Honey, spoken reply ready.";
  hoisted.runBodies.length = 0;
});

afterEach(() => {
  delete process.env.MWP_STACK_TOKEN_FILE;
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function post(body: unknown, token?: string, headers?: HeadersInit): Promise<Response> {
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  return POST(
    new Request(`${ORIGIN}/api/cockpit/honey${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function get(token?: string): Promise<Response> {
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  return GET(new Request(`${ORIGIN}/api/cockpit/honey${qs}`));
}

// --- GET ping ---

it("GET ping answers the contract and probes the engine", async () => {
  const res = await get();
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    engine: string;
    usage: { method: string; body: { text: string } };
  };
  expect(body.ok).toBe(true);
  expect(body.engine).toBe("reachable");
  expect(body.usage.method).toBe("POST");
  expect(body.usage.body.text).toBeTruthy();
});

it("GET ping survives the adapter being down — still 200, engine down", async () => {
  hoisted.anchorThread = null;
  const res = await get();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { engine: string };
  expect(body.engine).toMatch(/^down/);
});

// --- POST, the Shortcut's lane ---

it("POST default format answers plain text the Shortcut can speak, no render", async () => {
  const res = await post({ text: "what's the weather" }, TOKEN);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");
  expect(await res.text()).toBe("Hello from Honey, spoken reply ready.");
  expect(hoisted.renderCalls).toEqual([]); // text mode = phone speaks it
});

it("POST format=json answers reply + absolute audioUrl via the shared render cache", async () => {
  const res = await post({ text: "read this back", format: "json" }, TOKEN);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { reply: string; audioUrl: string };
  expect(body.reply).toBe("Hello from Honey, spoken reply ready.");
  expect(body.audioUrl).toBe(
    `${ORIGIN}/api/cockpit/voice/audio?id=${hoisted.renderHash}.m4a`,
  );
  expect(hoisted.renderCalls).toEqual([body.reply]); // rendered ONCE, from the reply
});

it("the run rides the cockpit's adapter lane — anchor thread, pinned phone device, shortcut surface", async () => {
  await post({ text: "lane check" }, TOKEN);
  expect(hoisted.runBodies).toHaveLength(1);
  const run = hoisted.runBodies[0] as {
    threadId: string;
    messages: { role: string; content: string }[];
    forwardedProps: Record<string, string>;
  };
  expect(run.threadId).toBe("anchor-thread-1");
  expect(run.messages).toHaveLength(1);
  expect(run.messages[0]).toMatchObject({ role: "user", content: "lane check" });
  expect(run.forwardedProps).toEqual({
    device: "phone",
    deviceSource: "pin",
    surface: "shortcut",
  });
});

it("anchor probe failure falls back to the stable shortcut thread and still replies", async () => {
  hoisted.anchorThread = null;
  const res = await post({ text: "anyone there" }, TOKEN);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Hello from Honey");
  expect(
    (hoisted.runBodies[0] as { threadId: string }).threadId,
  ).toBe("shortcut-honey");
});

it("RUN_ERROR answers 502 with the adapter's own message", async () => {
  hoisted.runError = "engine exited 1";
  const res = await post({ text: "boom" }, TOKEN);
  expect(res.status).toBe(502);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("engine exited 1");
});

it("adapter unreachable or non-200 answers 502, never a hang", async () => {
  hoisted.failRun = true;
  const res1 = await post({ text: "down" }, TOKEN);
  expect(res1.status).toBe(502);
  hoisted.failRun = false;
  hoisted.runStatus = 500;
  const res2 = await post({ text: "500" }, TOKEN);
  expect(res2.status).toBe(502);
});

it("a run that yields no text answers 502 — RUN_FINISHED alone is not a reply", async () => {
  hoisted.runText = null;
  const res = await post({ text: "silent" }, TOKEN);
  expect(res.status).toBe(502);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("engine returned no text");
});

it("render failure in json mode still answers the reply with audioUrl null + voiceError", async () => {
  hoisted.failRender = true;
  const res = await post({ text: "still answer me", format: "json" }, TOKEN);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    reply: string;
    audioUrl: string | null;
    voiceError: string;
  };
  expect(body.reply).toBe("Hello from Honey, spoken reply ready.");
  expect(body.audioUrl).toBeNull();
  expect(body.voiceError).toBe("render exploded");
});

// --- auth (token doors law b959ac33) ---

it("a wrong token 401s; the right token passes by query AND Authorization header; no token rides the sibling posture", async () => {
  const bad = await post({ text: "hi" }, "wrong-token");
  expect(bad.status).toBe(401);
  const byQuery = await post({ text: "hi" }, TOKEN);
  expect(byQuery.status).toBe(200);
  const byHeader = await post(
    { text: "hi" },
    undefined,
    { Authorization: `Bearer ${TOKEN}` },
  );
  expect(byHeader.status).toBe(200);
  const noToken = await post({ text: "hi" });
  expect(noToken.status).toBe(200); // same trust boundary as every /api/cockpit/* route
});

it("a presented token with no readable stack token 503s (fail closed on explicit auth)", async () => {
  process.env.MWP_STACK_TOKEN_FILE = path.join(scratch, "missing-token");
  const res = await post({ text: "hi" }, TOKEN);
  expect(res.status).toBe(503);
});

// --- body validation ---

it("malformed bodies answer 400", async () => {
  const noText = await post({ format: "json" }, TOKEN);
  expect(noText.status).toBe(400);
  const badFormat = await post({ text: "hi", format: "mp3" }, TOKEN);
  expect(badFormat.status).toBe(400);
  const notJson = await POST(
    new Request(`${ORIGIN}/api/cockpit/honey?token=${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    }),
  );
  expect(notJson.status).toBe(400);
  // nothing reached the adapter for any of them
  expect(hoisted.runBodies).toEqual([]);
});
