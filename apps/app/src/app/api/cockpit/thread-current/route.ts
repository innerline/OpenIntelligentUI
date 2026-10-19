import { NextResponse } from "next/server";
import {
  HONEY_AGUI_URL,
  LARRY_AGUI_URL,
  PI_AGUI_URL,
} from "@/lib/copilotkit-runtime-options";

// pi rides the tailnet adapter (pi-platform smallest visible loop, gate
// 2026-10-19). Its /thread/current endpoint is the credited fast-follow —
// until it lands, the catch below answers the graceful null fallback.
const AGENT_BASES: Record<"honey" | "larry" | "pi", string> = {
  honey: HONEY_AGUI_URL,
  larry: LARRY_AGUI_URL,
  pi: PI_AGUI_URL,
};

// Cockpit thread anchor — the adapters answer GET /thread/current with the
// persona's most recently active thread (derived from their transcript
// store). The browser cannot reach the loopback adapters directly, so this
// route proxies server-side, same pattern as thread-messages. It powers the
// cross-device rejoin in engine-chat.tsx (kanban/cockpit-thread-continuity,
// 2026-10-18): localStorage thread pins are per browser, so phone + laptop
// each minted their own thread and the owner's conversation scattered — a
// second device now adopts the anchor instead of forking a new thread.

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agent = searchParams.get("agent");
  if (agent !== "honey" && agent !== "larry" && agent !== "pi") {
    return NextResponse.json(
      { error: "expected ?agent=honey|larry|pi" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const base = AGENT_BASES[agent];
  try {
    const upstream = await fetch(`${base}thread/current`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (e) {
    // Adapter down: answer null so the page falls back to its localStorage
    // pin — the status banner already warns the engine is unreachable.
    return NextResponse.json(
      { threadId: null, detail: e instanceof Error ? e.message : "unreachable" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
