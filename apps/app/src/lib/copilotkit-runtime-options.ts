import { LangGraphHttpAgent } from "@copilotkit/runtime/langgraph";
import { HttpAgent, type RunAgentInput } from "@ag-ui/client";

import type { ProviderHeaders } from "./provider-keys";

class CredentialSafeLangGraphAgent extends LangGraphHttpAgent {
  protected override requestInit(input: Parameters<LangGraphHttpAgent["requestInit"]>[0]): RequestInit {
    // Custom credential headers survive cross-origin fetch redirects. Fail closed.
    return { ...super.requestInit(input), redirect: "error" };
  }
}

// The peer address of the BROWSER's request, as seen by this server.
// Next's Node server sets x-forwarded-for to the socket's remote
// address when nothing else has (base-server: x-forwarded-for ??=
// socket.remoteAddress), so a direct tailnet connection arrives
// carrying the connecting machine's address; behind a forwarding proxy
// the proxy's own header wins (first entry = the original client).
// Spoofable by a hostile client — accepted on the owner-only tailnet
// this cockpit serves. x-real-ip is the nginx-convention fallback.
export function extractClientPeer(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  return headers.get("x-real-ip")?.trim() || null;
}

// Server-side owner-device classification (kanban/device-input-matrix,
// owner hit #3, 2026-10-18: on his laptop, tagged studio — a browser
// cannot tell the desks apart, but the connecting machine's address
// can). Every AG-UI run this edge proxies to the adapters is stamped
// with the browser's REAL peer address and User-Agent, riding
// forwardedProps next to the client's own (sourced) device tag:
//   devicePeer       — the browser's address as this server saw it
//   deviceUserAgent  — the browser's User-Agent header
// The ADAPTER resolves the final tag: pin → UA phone/ipad → peer
// (loopback/Studio address = studio, any other = laptop) → the
// client's heuristic guess → studio. requestInit is @ag-ui's
// documented customization hook; a missing signal is simply not
// stamped (the adapter falls back, never breaks).
class PeerTaggedHttpAgent extends HttpAgent {
  constructor(
    config: ConstructorParameters<typeof HttpAgent>[0],
    private client: { peer?: string | null; userAgent?: string | null },
  ) {
    super(config);
  }

  protected override requestInit(input: RunAgentInput): RequestInit {
    const forwarded = (input.forwardedProps ?? {}) as Record<string, unknown>;
    input.forwardedProps = {
      ...forwarded,
      ...(this.client.peer ? { devicePeer: this.client.peer } : {}),
      ...(this.client.userAgent ? { deviceUserAgent: this.client.userAgent } : {}),
    };
    return super.requestInit(input);
  }
}

export interface RuntimeOptionsEnv {
  langgraphUrl?: string;
  mcpServerUrl?: string;
  providerHeaders?: ProviderHeaders;
  /** The browser's real peer address, captured at the route edge. */
  clientPeer?: string | null;
  /** The browser's User-Agent, captured at the route edge. */
  clientUserAgent?: string | null;
}

// Cockpit engine surfaces (Honey / Larry) — plain AG-UI endpoints on the
// Studio (honey_agui + larry-agui adapters), the same wire OpenBot's
// remote-ag-ui bots speak: POST RunAgentInput -> SSE event stream.
// Env-overridable so the same build runs against local dev adapters.
export const HONEY_AGUI_URL = process.env.HONEY_AGUI_URL || "http://127.0.0.1:8126/";
export const LARRY_AGUI_URL = process.env.LARRY_AGUI_URL || "http://127.0.0.1:8127/";

// Normalize Render's fromService hostport (bare host:port) into a full URL
export function normalizeLanggraphUrl(raw?: string): string {
  if (!raw) return "http://localhost:8123";
  return raw.startsWith("http") ? raw : `http://${raw}`;
}

export function buildRuntimeOptions(env: RuntimeOptionsEnv) {
  return {
    agents: {
      default: new CredentialSafeLangGraphAgent({
        url: normalizeLanggraphUrl(env.langgraphUrl),
        ...(env.providerHeaders && { headers: env.providerHeaders }),
      }),
      // Cockpit tabs — chat surfaces against the Honey / Larry engine
      // adapters. The engines hold their own model keys, so provider
      // headers from the browser are deliberately NOT forwarded here.
      // PeerTaggedHttpAgent stamps the browser's peer address + UA onto
      // every proxied run so the adapters classify the desk server-side.
      honey: new PeerTaggedHttpAgent(
        { url: HONEY_AGUI_URL },
        { peer: env.clientPeer, userAgent: env.clientUserAgent },
      ),
      larry: new PeerTaggedHttpAgent(
        { url: LARRY_AGUI_URL },
        { peer: env.clientPeer, userAgent: env.clientUserAgent },
      ),
    },
    a2ui: { injectA2UITool: true },
    openGenerativeUI: true as const,
    ...(env.mcpServerUrl && {
      mcpApps: {
        servers: [{
          type: "http" as const,
          url: env.mcpServerUrl,
          serverId: "example_mcp_app",
        }],
      },
    }),
  };
}
