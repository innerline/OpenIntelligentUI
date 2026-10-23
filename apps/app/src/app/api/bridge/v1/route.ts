import { NextResponse } from "next/server";
import {
  BRIDGE_CORS,
  BRIDGE_MODEL_IDS,
  BRIDGE_NO_STORE,
} from "@/app/api/bridge/v1/bridge-shared";

// GET/OPTIONS /api/bridge/v1 — the bare base ping. Some OpenAI-shaped
// clients probe the configured base URL itself before/alongside model
// discovery; before this file the only thing under /api/bridge/v1/* was
// chat/completions, so a bare ping fell through to Next's 404. Answers a
// descriptive 200.
//
// Deliberately open (no token asked): it names nothing the
// chat/completions GET contract ping doesn't already name to the same
// tailnet-bound caller, and a client that pings the base before sending
// credentials still finds the door — the whole point of this route.
//
// CORS: permissive on this route only (see bridge-shared) — the Obsidian
// renderer origin can never be predicted.

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...BRIDGE_NO_STORE, ...BRIDGE_CORS },
  });
}

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      service: "honey-larry-bridge",
      models: [...BRIDGE_MODEL_IDS],
    },
    { headers: { ...BRIDGE_NO_STORE, ...BRIDGE_CORS } },
  );
}
