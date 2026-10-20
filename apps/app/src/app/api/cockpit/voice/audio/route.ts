import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { voiceDir } from "@/lib/voice-render";

// GET /api/cockpit/voice/audio?id=<hash>.m4a — serves a rendered voice
// note (see the render route). Same-origin like every other cockpit
// API; the id is validated against the render lane's own hash shape so
// this can never read outside runtime/voice. Range requests are
// honored (206) — iOS Safari asks for them and refuses some audio
// without.
//
//   200/206: audio/mp4 bytes
//   400: malformed id · 404: pruned or never rendered

export const dynamic = "force-dynamic";

const AUDIO_ID = /^[a-f0-9]{64}\.m4a$/;

function audioHeaders(extra: Record<string, string>): Headers {
  return new Headers({
    "Content-Type": "audio/mp4",
    "Accept-Ranges": "bytes",
    // Private: chat-derived audio, cached as long as the prune lane
    // keeps it (files live 24h; the browser re-asks the render route).
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id") ?? "";
  if (!AUDIO_ID.test(id)) {
    return new NextResponse("malformed voice note id", {
      status: 400,
      headers: audioHeaders({}),
    });
  }
  const file = path.join(voiceDir(), id);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return new NextResponse("voice note not found", {
      status: 404,
      headers: audioHeaders({}),
    });
  }
  const range = request.headers.get("range");
  const m = range?.match(/^bytes=(\d+)-(\d*)$/);
  if (m) {
    const start = Math.min(Number(m[1]), bytes.length);
    const end = m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
    if (start > end) {
      return new NextResponse(null, {
        status: 416,
        headers: audioHeaders({ "Content-Range": `bytes */${bytes.length}` }),
      });
    }
    return new NextResponse(new Uint8Array(bytes.subarray(start, end + 1)), {
      status: 206,
      headers: audioHeaders({
        "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        "Content-Length": String(end - start + 1),
      }),
    });
  }
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: audioHeaders({ "Content-Length": String(bytes.length) }),
  });
}
