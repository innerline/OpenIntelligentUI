import fs from "fs";

// Shared bits for the two GET discovery doors under /api/bridge/v1 (the
// models list + the bare base ping, both added 2026-10-23 for the Obsidian
// Copilot Plus custom-model validation: the plugin probes `GET {base}/models`
// before it accepts honey/larry, and some clients ping the bare base too).
// chat/completions/route.ts deliberately keeps its OWN copies untouched —
// its live behavior is locked by its 21-test suite; this module is the one
// place the two NEW doors derive from so they can never drift apart.
//
// NOT a route: in the App Router only convention files (route.ts, page.tsx,
// …) become endpoints — this plain module is invisible to routing.

// The two personas this bridge serves — switching model = switching persona
// (kanban/unified-honey K5). Const tuple so the models list, the base ping,
// and any future door share one source of truth.
export const BRIDGE_MODEL_IDS = ["honey", "larry"] as const;

// Fixed epoch for the models list: 2026-10-21T00:00:00Z, the day the K5
// bridge landed. OpenAI's `created` is informational; a constant keeps the
// discovery response byte-stable across calls.
export const BRIDGE_MODEL_CREATED_EPOCH = 1_792_540_800;

export const BRIDGE_NO_STORE = { "Cache-Control": "no-store" } as const;

// Permissive on the bridge doors only — the same rationale as
// chat/completions: Obsidian's renderer origin (app://obsidian.md or a
// localhost variant) can never be predicted, and without ACAO:* the
// plugin's discovery fetch is CORS-blocked before it reaches the lane. No
// credentials are in play (the token rides a header, not cookies).
export const BRIDGE_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-mwp-token, x-requested-with",
  "Access-Control-Max-Age": "86400",
} as const;

// Read at CALL time, not module load — the seam law (tests and unusual
// mounts point MWP_STACK_TOKEN_FILE elsewhere after the module is already
// imported; same as chat/completions).
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

// The token the caller presented, or null when none was — the same three
// shapes chat/completions accepts (Bearer first: that is the API-key field
// OpenAI-shaped clients like Copilot Plus store, then the platform's own
// ?token= / x-mwp-token).
function presentedToken(request: Request, url: URL): string | null {
  return (
    bearerToken(request.headers.get("authorization")) ||
    url.searchParams.get("token") ||
    request.headers.get("x-mwp-token")
  );
}

// The discovery doors' verdict: true only when a token was presented AND it
// matches the stack token. Everything else — no token, a wrong token, or an
// unreadable token file — is "not established". Deliberately stricter than
// the chat/completions sibling posture (which lets token-less callers ride
// the tailnet-bind trust boundary): /v1/models is THE scanner path for open
// LLM proxies, so a discovery door that is not convinced fails 404-quiet —
// byte-class identical to the route-not-here answer a prober saw before
// these doors existed — never 401/503-loud.
export function tokenEstablished(request: Request): boolean {
  const presented = presentedToken(request, new URL(request.url));
  if (presented === null) return false;
  const actual = stackToken();
  return actual !== null && presented === actual;
}
