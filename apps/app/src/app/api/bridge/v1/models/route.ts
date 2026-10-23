import { NextResponse } from "next/server";
import {
  BRIDGE_CORS,
  BRIDGE_MODEL_CREATED_EPOCH,
  BRIDGE_MODEL_IDS,
  BRIDGE_NO_STORE,
  tokenEstablished,
} from "@/app/api/bridge/v1/bridge-shared";

// GET/OPTIONS /api/bridge/v1/models — the OpenAI model-discovery call the
// Obsidian Copilot Plus plugin makes when validating a custom model (owner
// hit 2026-10-23: the plugin's `GET {base}/models` 404'd because this route
// never existed, so it refused to add honey/larry — chat/completions itself
// was never the problem). Answers the OpenAI list shape with exactly the
// two personas this bridge serves: switching model = switching persona
// (kanban/unified-honey K5).
//
// Auth: the same token SHAPES as chat/completions (?token= /
// Authorization: Bearer / x-mwp-token, validated against the stack token)
// — but a discovery door that is not convinced fails as 404: no token,
// wrong token, or an unreadable token file all answer the same 404-class
// response an unauthenticated prober saw before this file existed, never
// 401/503. Scanning leaks nothing, while the owner's setup validates
// first try — the plugin sends its stored key as Authorization: Bearer on
// discovery.
//
// CORS: permissive on this route only (see bridge-shared) — without ACAO:*
// the plugin's renderer fetch is blocked before it reaches this lane.

export const dynamic = "force-dynamic";

// OpenAI-shaped error body, 404 by design — reads natively in any
// OpenAI client, reveals nothing (no names, no hints).
function notFound(): NextResponse {
  return NextResponse.json(
    { error: { message: "Not Found", type: "invalid_request_error" } },
    { status: 404, headers: { ...BRIDGE_NO_STORE, ...BRIDGE_CORS } },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...BRIDGE_NO_STORE, ...BRIDGE_CORS },
  });
}

export async function GET(request: Request) {
  if (!tokenEstablished(request)) return notFound();
  return NextResponse.json(
    {
      object: "list",
      data: BRIDGE_MODEL_IDS.map((id) => ({
        id,
        object: "model",
        created: BRIDGE_MODEL_CREATED_EPOCH,
        owned_by: "mwp",
      })),
    },
    { headers: { ...BRIDGE_NO_STORE, ...BRIDGE_CORS } },
  );
}
