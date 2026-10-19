import { NextResponse } from "next/server";
import { HONEY_AGUI_URL, LARRY_AGUI_URL, PI_AGUI_URL } from "@/lib/copilotkit-runtime-options";

// Cockpit engine status — the Honey / Larry / Pi AG-UI adapters live on
// the Studio (honey/larry on loopback, pi on the tailnet IP), so the
// browser cannot probe them directly. This route checks /healthz
// server-side (read-only) and reports what it saw. It is a status
// light, not a gate: the chat surfaces stay usable whatever it says,
// and show their own errors if a run fails.

export const dynamic = "force-dynamic";

export type EngineStatus = { ok: boolean; detail: string };

async function probe(url: string): Promise<EngineStatus> {
  const health = new URL("healthz", url).href;
  try {
    const res = await fetch(health, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false, detail: `healthz HTTP ${res.status}` };
    const body = (await res.json()) as Record<string, unknown>;
    // The adapters answer {"ok":true,"engine":"…","agent":"…","model":"…"}
    // (pi-agui: {"ok":true,"seat":"pi","model":"…"}).
    const bits = ["engine", "agent", "seat", "model"]
      .filter((k) => typeof body[k] === "string")
      .map((k) => String(body[k]));
    return { ok: true, detail: bits.join(" · ") };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "unreachable" };
  }
}

export async function GET() {
  const [honey, larry, pi] = await Promise.all([
    probe(HONEY_AGUI_URL),
    probe(LARRY_AGUI_URL),
    probe(PI_AGUI_URL),
  ]);
  return NextResponse.json(
    { honey, larry, pi },
    { headers: { "Cache-Control": "no-store" } },
  );
}
