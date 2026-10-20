import { NextResponse } from "next/server";
import fs from "fs";
import { HONEY_AGUI_URL } from "@/lib/copilotkit-runtime-options";
import { renderVoiceFile } from "@/lib/voice-render";

// POST/GET /api/cockpit/honey — the iOS Honey Shortcut endpoint (owner
// directive 2026-10-20: AirPods stem press → Siri → Shortcut "Honey" →
// phone dictation → this route → Honey's reply spoken back through the
// AirPods). NOT a second engine path: the dictated text is posted into
// the SAME Honey adapter run lane the cockpit's /api/copilotkit proxy
// speaks to (HONEY_AGUI_URL → engine/honey_agui.py), so the reply comes
// from the one unified Honey session. The thread is adopted from the
// adapter's /thread/current anchor (stable fallback "shortcut-honey" —
// the buzz-shim pattern, maintenance/honey_buzz_acp.py), and the run is
// tagged forwardedProps { device: "phone", deviceSource: "pin",
// surface: "shortcut" } so the device law holds per input: the engine
// sees OWNER DEVICE: phone and answers short and voice-ready.
//
//   POST { text: string, format?: "json" | "text" }   (default: text)
//     format=text → 200 text/plain — JUST the reply text. Shortcuts
//                   "Get contents of URL" → "Speak Text" is most
//                   reliable on a plain body; no voice render happens
//                   (the phone speaks the text itself).
//     format=json → 200 { reply, audioUrl, voiceError? } — audioUrl is
//                   an absolute URL into the SHARED voice-note cache
//                   (renderVoiceFile → /api/cockpit/voice/audio — same
//                   render + same cache every cockpit reply uses). A
//                   render failure still answers 200 with audioUrl:
//                   null + voiceError so the Shortcut can fall back to
//                   speaking the reply text.
//     400 malformed body · 401 bad token · 502 engine lane failed
//   GET  → owner-friendly ping: contract summary + adapter probe.
//
// Auth: the sibling cockpit routes' posture (the app's tailnet-only
// bind is the trust boundary — no in-app middleware exists) PLUS the
// platform token doors (law b959ac33): a token presented via ?token=,
// x-mwp-token, or Authorization: Bearer is validated against the stack
// token (agentic-stack/runtime/token, MWP_STACK_TOKEN_FILE seam — the
// same file the honeyui proxy inlines server-side). A presented token
// that is wrong 401s; a presented token with no readable stack token
// 503s; NO token presented rides the same posture as every other
// /api/cockpit/* route. The iOS Shortcut calls with ?token= so it
// needs no cookies.
//
// Budget: the run fetch waits up to HONEY_SHORTCUT_TIMEOUT_MS (default
// 180s — the adapter's own ceiling is 600s; Siri gives up long before
// either). Anchor/probe fetches wait 2.5s, matching the sibling
// thread-current proxy.

export const dynamic = "force-dynamic";

const FALLBACK_THREAD = "shortcut-honey";
const RUN_TIMEOUT_MS =
  Number(process.env.HONEY_SHORTCUT_TIMEOUT_MS) || 180_000;
const PROBE_TIMEOUT_MS = 2500;
const NO_STORE = { "Cache-Control": "no-store" } as const;

function adapterBase(): string {
  // HONEY_AGUI_URL ships with a trailing slash; tolerate one without.
  return HONEY_AGUI_URL.endsWith("/") ? HONEY_AGUI_URL : `${HONEY_AGUI_URL}/`;
}

// Read at CALL time, not module load — tests (and unusual mounts) point
// the seam elsewhere after the module is already imported (the
// voiceDir() law).
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

// The token the caller presented, or null when none was. Query first
// (the Shortcut lane), then the two header shapes.
function presentedToken(request: Request, url: URL): string | null {
  return (
    url.searchParams.get("token") ||
    request.headers.get("x-mwp-token") ||
    bearerToken(request.headers.get("authorization"))
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

// The persona's current anchor thread — the Shortcut rejoins whichever
// conversation the cockpit is on, never mints a private one. Any
// failure → the stable fallback (whose turns still land in the SAME
// unified engine session).
async function resolveAnchorThread(): Promise<string> {
  try {
    const res = await fetch(`${adapterBase()}thread/current`, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return FALLBACK_THREAD;
    const body = (await res.json()) as { threadId?: unknown };
    return typeof body.threadId === "string" && body.threadId
      ? body.threadId
      : FALLBACK_THREAD;
  } catch {
    return FALLBACK_THREAD;
  }
}

// Accumulate every TEXT_MESSAGE_CONTENT delta across all assistant
// messages (the adapter already strips VISUAL machine lines); surface
// RUN_ERROR verbatim — the adapter's own words, same as the buzz shim.
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

// One turn through the unified run lane (same wire the cockpit proxy
// and the buzz shim speak): RunAgentInput in, SSE out, full text back.
async function runHoney(text: string, threadId: string): Promise<string> {
  const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const res = await fetch(adapterBase(), {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      threadId,
      runId,
      messages: [{ id: `shortcut-${runId}`, role: "user", content: text }],
      forwardedProps: {
        device: "phone",
        deviceSource: "pin",
        surface: "shortcut",
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

export async function POST(request: Request) {
  const denied = checkAuth(request);
  if (denied) {
    return NextResponse.json(
      { error: denied.error },
      { status: denied.status, headers: NO_STORE },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "expected a JSON body" },
      { status: 400, headers: NO_STORE },
    );
  }
  const { text, format } = (body ?? {}) as { text?: unknown; format?: unknown };
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json(
      { error: "expected body.text (non-empty string)" },
      { status: 400, headers: NO_STORE },
    );
  }
  const fmt = format === undefined ? "text" : format;
  if (fmt !== "json" && fmt !== "text") {
    return NextResponse.json(
      { error: 'body.format must be "json" or "text" (default: text)' },
      { status: 400, headers: NO_STORE },
    );
  }

  const threadId = await resolveAnchorThread();
  let reply: string;
  try {
    reply = await runHoney(text.trim(), threadId);
  } catch (e) {
    // The Shortcut fails visibly on non-2xx — right for a broken lane.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "engine run failed" },
      { status: 502, headers: NO_STORE },
    );
  }

  if (fmt === "text") {
    return new NextResponse(reply, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE },
    });
  }

  // json — render through the shared voice cache; a render failure
  // downgrades to a text-only answer, never a lost reply.
  const origin = new URL(request.url).origin;
  try {
    const { hash } = await renderVoiceFile(reply);
    return NextResponse.json(
      {
        reply,
        audioUrl: `${origin}/api/cockpit/voice/audio?id=${hash}.m4a`,
      },
      { headers: NO_STORE },
    );
  } catch (e) {
    return NextResponse.json(
      {
        reply,
        audioUrl: null,
        voiceError: e instanceof Error ? e.message : "render failed",
      },
      { headers: NO_STORE },
    );
  }
}

export async function GET(request: Request) {
  const denied = checkAuth(request);
  if (denied) {
    return NextResponse.json(
      { error: denied.error },
      { status: denied.status, headers: NO_STORE },
    );
  }
  let engine = "reachable";
  try {
    const res = await fetch(`${adapterBase()}thread/current`, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) engine = `down (adapter answered ${res.status})`;
  } catch (e) {
    engine = `down (${e instanceof Error ? e.message : "unreachable"})`;
  }
  return NextResponse.json(
    {
      ok: true,
      service: "honey — iOS Shortcut endpoint",
      engine,
      usage: {
        method: "POST",
        url: "/api/cockpit/honey?token=<stack token>",
        body: {
          text: "what you say to Siri",
          format:
            'optional: "text" (default — plain reply, speak it) | "json" (reply + audioUrl)',
        },
      },
    },
    { headers: NO_STORE },
  );
}
