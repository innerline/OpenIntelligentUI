import { NextResponse } from "next/server";
import fs from "fs";
import { rewriteHoneyuiHtml, rewriteHoneyuiJs } from "@/lib/honeyui-proxy";

// honeyui render proxy — the cockpit's embed lane for the pointed map
// (Excalidraw) and plex renders (kanban/device-input-matrix slice 2).
// The browser cannot reach honeyui's keyed surface directly, so this
// route forwards server-side — the same pattern as thread-current —
// inlining the stack token on every forwarded request (token law
// b959ac33: the owner must never hit a 401). The token lives
// server-side only; it never appears in browser HTML or JS.
//
//   GET  /api/cockpit/honeyui/?map=<path>   the page, map tab open
//   GET  /api/cockpit/honeyui/?plex=<path>  the page, plex tab open
//   …plus everything the page itself loads (app.js, chunks, /api/*).
//
// Root-absolute URLs inside the page/bundle are rewritten to this
// prefix (lib/honeyui-proxy) so the iframe stays self-contained on the
// cockpit origin. Binary assets (icons, raw images) pass through
// untouched.

export const dynamic = "force-dynamic";

// honeyui binds the tailnet IP only (server.py HOST default
// 100.81.213.106 — the phone lane needs it there), never loopback, so
// 127.0.0.1 502'd live: the sidebar's map/plex embeds and their
// click-throughs all landed on "honeyui unreachable". Default to the
// stable twin instance on the tailnet (the 8135 port is the
// register-retired legacy door; both serve the same static build,
// verified byte-identical 2026-10-22). Server-side hop only — the owner
// still only ever sees the :3210 same-origin URL.
const HONEYUI_URL =
  process.env.HONEYUI_URL || "http://100.81.213.106:8136";
const STACK_TOKEN_FILE =
  process.env.MWP_STACK_TOKEN_FILE ||
  "/Users/silverhawk/GitHub/agentic-stack/runtime/token";

function stackToken(): string | null {
  try {
    return fs.readFileSync(STACK_TOKEN_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function forward(
  request: Request,
  segments: string[],
): Promise<NextResponse> {
  const token = stackToken();
  if (!token) {
    return new NextResponse("honeyui token unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const incoming = new URL(request.url);
  const q = new URLSearchParams(incoming.search);
  q.set("t", token); // inline, server-side, on every request
  const rel = segments.map((s) => encodeURIComponent(s)).join("/");
  const upstream = new URL(`${HONEYUI_URL}/${rel}`);
  upstream.search = q.toString();

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      ...(request.method === "POST" && {
        method: "POST",
        headers: {
          "Content-Type": request.headers.get("content-type") ?? "application/json",
        },
        body: await request.text(),
      }),
    });
  } catch (e) {
    return new NextResponse(
      `honeyui unreachable (${e instanceof Error ? e.message : "error"})`,
      { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  const ctype = upstreamRes.headers.get("content-type") ?? "application/octet-stream";
  const headers = new Headers({
    "Content-Type": ctype,
    "Cache-Control": upstreamRes.headers.get("cache-control") ?? "no-store",
    "X-Content-Type-Options": "nosniff",
  });

  // The page: rewrite its root-absolute refs onto the proxy prefix.
  if (ctype.includes("text/html")) {
    return new NextResponse(rewriteHoneyuiHtml(await upstreamRes.text()), {
      status: upstreamRes.status,
      headers,
    });
  }
  // The entry bundle only — hashed lazy chunks import relative and must
  // pass through byte-exact (rewriting them risks corrupting Excalidraw).
  if (ctype.includes("javascript") && segments[0]?.startsWith("app.js")) {
    return new NextResponse(rewriteHoneyuiJs(await upstreamRes.text()), {
      status: upstreamRes.status,
      headers,
    });
  }
  return new NextResponse(await upstreamRes.arrayBuffer(), {
    status: upstreamRes.status,
    headers,
  });
}

type Ctx = { params: Promise<{ path?: string[] }> };

export async function GET(request: Request, ctx: Ctx) {
  const { path } = await ctx.params;
  return forward(request, path ?? []);
}

export async function POST(request: Request, ctx: Ctx) {
  const { path } = await ctx.params;
  return forward(request, path ?? []);
}
