import { NextResponse } from "next/server";
import { HONEY_AGUI_URL, LARRY_AGUI_URL } from "@/lib/copilotkit-runtime-options";

// Cockpit thread history — the adapters keep a per-thread transcript
// (runtime/agui_transcripts.json) and serve it at GET /threads/{id}. The
// browser cannot reach the loopback adapters directly, so this route
// proxies server-side, same pattern as the engine-status probe. It powers
// the remount-restore in engine-chat.tsx (owner 2026-10-17: Safari
// discarded the backgrounded tab and the chat lost its thread).

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agent = searchParams.get("agent");
  const thread = searchParams.get("thread");
  if ((agent !== "honey" && agent !== "larry") || !thread) {
    return NextResponse.json(
      { error: "expected ?agent=honey|larry&thread=<threadId>" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const base = agent === "honey" ? HONEY_AGUI_URL : LARRY_AGUI_URL;
  try {
    const upstream = await fetch(
      `${base}threads/${encodeURIComponent(thread)}`,
      { cache: "no-store", signal: AbortSignal.timeout(2500) },
    );
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (e) {
    // Adapter down: answer empty so the page treats it as "nothing to
    // restore" — the status banner already warns the engine is unreachable.
    return NextResponse.json(
      { threadId: thread, messages: [], detail: e instanceof Error ? e.message : "unreachable" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
