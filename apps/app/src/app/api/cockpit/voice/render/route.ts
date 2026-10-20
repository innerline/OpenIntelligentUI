import { NextResponse } from "next/server";
import { renderVoiceFile } from "@/lib/voice-render";

// POST /api/cockpit/voice/render — server-rendered voice notes for
// Honey's replies (kanban/device-input-matrix, iPhone voice contract).
// The cockpit server runs on the macOS Studio; the render lib renders
// the text into runtime/voice/<hash>.m4a once — piper (local neural
// TTS) when the runtime override selects it, the native `say` CLI
// otherwise (and as piper's fallback). Identical replies hit the hash
// and never re-render. The reply URL is served by the sibling audio
// route — same-origin, same posture as every other /api/cockpit/*
// route (the browser already proved that lane).
//
//   body: { text: string, sessionHint?: string }
//   200: { url: "/api/cockpit/voice/audio?id=<hash>.m4a", cached: bool, voice: string|null }
//   400/500: { error }
//
// sessionHint is accepted for diagnostics/future session affinity and
// is deliberately NOT part of the hash — identical replies share one
// render no matter which session asked.

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "expected a JSON body" }, { status: 400 });
  }
  const { text, sessionHint } = (body ?? {}) as {
    text?: unknown;
    sessionHint?: unknown;
  };
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json(
      { error: "expected body.text (non-empty string)" },
      { status: 400 },
    );
  }
  if (
    sessionHint !== undefined &&
    (typeof sessionHint !== "string" || sessionHint.length > 200)
  ) {
    return NextResponse.json(
      { error: "body.sessionHint must be a string of at most 200 chars" },
      { status: 400 },
    );
  }
  try {
    const { hash, cached, voice } = await renderVoiceFile(text);
    return NextResponse.json(
      {
        url: `/api/cockpit/voice/audio?id=${hash}.m4a`,
        cached,
        voice,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    // The client turns this into a visible "voice render failed" chip.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "render failed" },
      { status: 500 },
    );
  }
}
