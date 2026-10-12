import { LangGraphHttpAgent } from "@copilotkit/runtime/langgraph";
import { HttpAgent } from "@ag-ui/client";

import type { ProviderHeaders } from "./provider-keys";

class CredentialSafeLangGraphAgent extends LangGraphHttpAgent {
  protected override requestInit(input: Parameters<LangGraphHttpAgent["requestInit"]>[0]): RequestInit {
    // Custom credential headers survive cross-origin fetch redirects. Fail closed.
    return { ...super.requestInit(input), redirect: "error" };
  }
}

export interface RuntimeOptionsEnv {
  langgraphUrl?: string;
  mcpServerUrl?: string;
  providerHeaders?: ProviderHeaders;
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
      honey: new HttpAgent({ url: HONEY_AGUI_URL }),
      larry: new HttpAgent({ url: LARRY_AGUI_URL }),
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
