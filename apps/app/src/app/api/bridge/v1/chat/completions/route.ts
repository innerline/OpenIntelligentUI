import { NextResponse } from "next/server";
import fs from "fs";
import {
  HONEY_AGUI_URL,
  LARRY_AGUI_URL,
  extractClientPeer,
} from "@/lib/copilotkit-runtime-options";

// POST/GET/OPTIONS /api/bridge/v1/chat/completions — the Obsidian Copilot
// Plus door into the ONE unified Honey/Larry session (kanban/unified-honey
// K5, owner hard request 2026-10-21). Exposes both personas as an
// OpenAI-compatible Chat Completions endpoint: Copilot Plus adds them as
// custom models (base URL http://100.81.213.106:3210/api/bridge/v1, API
// key = the platform token, model names honey / larry), so SWITCHING
// MODEL = SWITCHING PERSONA while every turn still lands in the same
// canonical engine session the cockpit, Buzz, and the Shortcut speak to.
//
// NOT a second engine path — the run lane is byte-for-byte the
// /api/cockpit/honey POST lane: RunAgentInput to the persona's AG-UI
// adapter (honey :8126 / larry :8127, shared module, same wire), thread
// adopted from the adapter's /thread/current anchor (stable fallbacks
// copilot-honey / copilot-larry), run tagged forwardedProps
// { device: "obsidian", deviceSource: "pin", surface: "copilot-plus" }.
//
// PERSONA INTEGRITY (deliberate, documented): only the LAST user message
// becomes the prompt. Obsidian Copilot prepends its own system prompts
// (vault context, chat instructions) and replays chat history as
// assistant/user messages — NONE of that is forwarded. The personas live
// in the platform (engine prompts + unified session memory), and the
// unified session already holds the conversation across every door;
// replaying Obsidian's copy would duplicate it. System messages are
// ignored, earlier user/assistant messages are ignored, one prompt rides.
//
// Streaming: implemented for stream:true from the start — a minimal SSE
// that emits the full reply as one content chunk (role chunk → content
// chunk → stop chunk → [DONE]). Rationale: OpenAI-shaped clients that
// request streaming parse the body as SSE and visibly error on a plain
// JSON body, and this build had no live Obsidian to prove the
// non-streaming shape accepted (no-live-bounce rule) — shipping both
// makes the owner's first setup attempt work either way. Shape verified
// by curl against the running app (see kanban receipt).
//
// Auth: the sibling cockpit posture (tailnet-only bind is the trust
// boundary) PLUS the platform token doors (law b959ac33): a token
// presented via ?token=, x-mwp-token, or Authorization: Bearer is
// validated against the stack token (agentic-stack/runtime/token,
// MWP_STACK_TOKEN_FILE seam). Copilot Plus stores one API key per
// custom model and sends it as `Authorization: Bearer <key>` — the
// owner pastes the PLATFORM TOKEN into the plugin's API key field; no
// token presented rides the sibling posture like every /api/cockpit/*
// route.
//
// CORS: permissive ON THIS ROUTE ONLY — Obsidian's renderer calls from
// app://obsidian.md (Electron) or https://localhost origins that the
// app could never allowlist; without ACAO:* the plugin's fetch is
// blocked before the request ever reaches the lane. No credentials are
// involved (the token rides a header, not cookies), so * is safe here.

export const dynamic = "force-dynamic";

type Lane = "honey" | "larry";

const LANES: Record<
  Lane,
  { base: string; fallbackThread: string; surfaceThreadNote: string }
> = {
  honey: {
    base: HONEY_AGUI_URL,
    fallbackThread: "copilot-honey",
    surfaceThreadNote: "Honey",
  },
  larry: {
    base: LARRY_AGUI_URL,
    fallbackThread: "copilot-larry",
    surfaceThreadNote: "Larry",
  },
};

const RUN_TIMEOUT_MS = Number(process.env.BRIDGE_RUN_TIMEOUT_MS) || 180_000;
const PROBE_TIMEOUT_MS = 2500;
const NO_STORE = { "Cache-Control": "no-store" } as const;
// Permissive on this route only (header comment): Obsidian's renderer
// origin can never be predicted, and no credential mode is in play.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-mwp-token, x-requested-with",
  "Access-Control-Max-Age": "86400",
} as const;

// Read at CALL time, not module load — tests (and unusual mounts) point
// the seam elsewhere after the module is already imported (the
// voiceDir() law, same as /api/cockpit/honey).
function stackTokenFile(): string {
  return (
    process.env.MWP_STACK_TOKEN_FILE ||
    "/Users/silverhawk/GitHub/agentic-stack/runtime/token"
  );
}

function stackToken(): string | null {
  try {
    return fs.readFileSync(stackTokenFile(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function bearerToken(header: string | null): string | null {
  const m = header?.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ? m[1].trim() : null;
}

// The token the caller presented, or null when none was. Bearer first
// (the OpenAI client lane — Copilot Plus sends the pasted platform
// token as the API key), then the platform's own shapes.
function presentedToken(request: Request, url: URL): string | null {
  return (
    bearerToken(request.headers.get("authorization")) ||
    url.searchParams.get("token") ||
    request.headers.get("x-mwp-token")
  );
}

type AuthFailure = { status: number; error: string };

function checkAuth(request: Request): AuthFailure | null {
  const presented = presentedToken(request, new URL(request.url));
  if (presented === null) return null; // sibling posture — tailnet bind
  const actual = stackToken();
  if (actual === null) {
    return {
      status: 503,
      error: "token unavailable (stack token file unreadable)",
    };
  }
  if (presented !== actual) return { status: 401, error: "bad token" };
  return null;
}

// OpenAI-shaped error body — the plugin surfaces error.message to the
// owner, so failures read natively in Copilot Plus.
function openaiError(
  status: number,
  message: string,
  type = "invalid_request_error",
): NextResponse {
  return NextResponse.json(
    { error: { message, type } },
    { status, headers: { ...NO_STORE, ...CORS } },
  );
}

function adapterBase(base: string): string {
  // AGUI URLs ship with a trailing slash; tolerate one without.
  return base.endsWith("/") ? base : `${base}/`;
}

// The persona's current anchor thread — the bridge rejoins whichever
// conversation the cockpit is on, never mints a private one. Any
// failure → the stable fallback (whose turns still land in the SAME
// unified engine session).
async function resolveAnchorThread(lane: Lane): Promise<string> {
  const { base, fallbackThread } = LANES[lane];
  try {
    const res = await fetch(`${adapterBase(base)}thread/current`, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return fallbackThread;
    const body = (await res.json()) as { threadId?: unknown };
    return typeof body.threadId === "string" && body.threadId
      ? body.threadId
      : fallbackThread;
  } catch {
    return fallbackThread;
  }
}

// Accumulate every TEXT_MESSAGE_CONTENT delta across all assistant
// messages (the adapter already strips VISUAL machine lines); surface
// RUN_ERROR verbatim — the adapter's own words (same law as the
// shortcut lane).
function parseSseReply(raw: string): string {
  let reply = "";
  for (const line of raw.split("\n")) {
    const payload = line.trim();
    if (!payload.startsWith("data:")) continue;
    const json = payload.slice("data:".length).trim();
    if (!json) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(json);
    } catch {
      continue; // keep-alive comment or split junk — never fatal
    }
    const e = ev as { type?: unknown; delta?: unknown; message?: unknown };
    if (e.type === "TEXT_MESSAGE_CONTENT" && typeof e.delta === "string") {
      reply += e.delta;
    } else if (e.type === "RUN_ERROR") {
      throw new Error(
        typeof e.message === "string" && e.message
          ? e.message
          : "engine run failed",
      );
    }
  }
  return reply;
}

// One turn through the unified run lane (same wire the cockpit proxy,
// the shortcut, and the buzz shim speak): RunAgentInput in, SSE out,
// full text back. Device/surface tags: the owner's word is the
// Copilot Plus door ("obsidian" pin + "copilot-plus" surface); the
// REAL peer address + User-Agent ride alongside exactly like the
// cockpit's /api/copilotkit edge stamps them, so the adapter's
// server-side device law (pin→UA→peer→remembered→studio) still
// resolves the truthful desk (laptop/studio/phone) — an unknown pin
// tag is advisory there and can never break a run.
async function runTurn(
  lane: Lane,
  text: string,
  threadId: string,
  peer: string | null,
  userAgent: string | null,
): Promise<string> {
  const { base } = LANES[lane];
  const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const res = await fetch(adapterBase(base), {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      threadId,
      runId,
      messages: [{ id: `copilot-${runId}`, role: "user", content: text }],
      forwardedProps: {
        device: "obsidian",
        deviceSource: "pin",
        surface: "copilot-plus",
        ...(peer ? { devicePeer: peer } : {}),
        ...(userAgent ? { deviceUserAgent: userAgent } : {}),
      },
    }),
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`adapter answered ${res.status}`);
  }
  const reply = parseSseReply(await res.text());
  if (!reply.trim()) throw new Error("engine returned no text");
  return reply;
}

// ---- OpenAI Chat Completions request parsing ----

type ChatMessage = { role?: unknown; content?: unknown };

// OpenAI message content is a string OR an array of typed parts
// (multimodal); the text is what this lane consumes — image parts have
// no lane today and are skipped, not fatal.
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part !== null &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

// The LAST user message — the one prompt this door forwards (header
// comment: persona integrity). System messages NEVER ride (Obsidian's
// own prompts stay out of Honey/Larry); earlier history stays out too
// (the unified session already holds it).
function lastUserPrompt(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as ChatMessage;
    if (
      m !== null &&
      typeof m === "object" &&
      (m as { role?: unknown }).role === "user"
    ) {
      const text = textOfContent((m as { content?: unknown }).content).trim();
      return text || null;
    }
  }
  return null;
}

// ---- OpenAI Chat Completions response shapes ----

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function completionId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function completionPayload(lane: Lane, prompt: string, reply: string) {
  const promptTokens = approxTokens(prompt);
  const completionTokens = approxTokens(reply);
  return {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: lane,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: reply },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// Minimal SSE stream (header comment): role chunk → the full reply as
// ONE content chunk → stop chunk → [DONE]. Standard OpenAI
// chat.completion.chunk wire shape, few chunks by design.
function sseBody(id: string, lane: Lane, reply: string): string {
  const base = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: lane,
  };
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return (
    chunk({ role: "assistant" }, null) +
    chunk({ content: reply }, null) +
    chunk({}, "stop") +
    "data: [DONE]\n\n"
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...NO_STORE, ...CORS } });
}

export async function POST(request: Request) {
  const denied = checkAuth(request);
  if (denied) {
    return openaiError(denied.status, denied.error, "invalid_request_error");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return openaiError(400, "expected a JSON body");
  }
  const { model, messages, stream } = (body ?? {}) as {
    model?: unknown;
    messages?: unknown;
    stream?: unknown;
  };

  if (typeof model !== "string" || !model.trim()) {
    return openaiError(400, 'body.model is required: "honey" or "larry"');
  }
  const lane = model.trim().toLowerCase();
  if (lane !== "honey" && lane !== "larry") {
    return openaiError(
      400,
      `unknown model "${model.trim()}" — this endpoint serves exactly two models: "honey" and "larry"`,
    );
  }

  const prompt = lastUserPrompt(messages);
  if (prompt === null) {
    return openaiError(
      400,
      "no user message found — at least one message with role \"user\" and non-empty text content is required (system messages are ignored: the Honey/Larry personas live in the platform, not in caller prompts)",
    );
  }

  const threadId = await resolveAnchorThread(lane as Lane);
  const peer = extractClientPeer(request.headers);
  const userAgent = request.headers.get("user-agent");

  let reply: string;
  try {
    reply = await runTurn(lane as Lane, prompt, threadId, peer, userAgent);
  } catch (e) {
    // The plugin surfaces this message to the owner — right for a
    // broken lane: visible, not a silent empty answer.
    return openaiError(
      502,
      e instanceof Error ? e.message : "engine run failed",
      "api_error",
    );
  }

  if (stream === true) {
    return new NextResponse(sseBody(completionId(), lane as Lane, reply), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        ...NO_STORE,
        ...CORS,
      },
    });
  }

  return NextResponse.json(completionPayload(lane as Lane, prompt, reply), {
    headers: { ...NO_STORE, ...CORS },
  });
}

export async function GET(request: Request) {
  const denied = checkAuth(request);
  if (denied) {
    return openaiError(denied.status, denied.error, "invalid_request_error");
  }
  const probe = async (lane: Lane) => {
    const { base } = LANES[lane];
    try {
      const res = await fetch(`${adapterBase(base)}thread/current`, {
        cache: "no-store",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return res.ok ? "reachable" : `down (adapter answered ${res.status})`;
    } catch (e) {
      return `down (${e instanceof Error ? e.message : "unreachable"})`;
    }
  };
  return NextResponse.json(
    {
      ok: true,
      service: "mwp bridge — OpenAI Chat Completions into the unified Honey/Larry session (Obsidian Copilot Plus door)",
      honey: await probe("honey"),
      larry: await probe("larry"),
      usage: {
        method: "POST",
        url: "/api/bridge/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer <platform token> (agentic-stack/runtime/token — the API key Copilot Plus stores)",
        },
        body: {
          model: '"honey" | "larry"  — switching model = switching persona',
          messages: '[{ role: "user", content: "…" }] — the LAST user message is the prompt; system messages are ignored (personas live in the platform)',
          stream: "optional boolean — true answers as an SSE chunk stream",
        },
        copilot_plus_setup: {
          base_url: "http://100.81.213.106:3210/api/bridge/v1",
          model_names: ["honey", "larry"],
          api_key: "the platform token",
        },
      },
    },
    { headers: { ...NO_STORE, ...CORS } },
  );
}
