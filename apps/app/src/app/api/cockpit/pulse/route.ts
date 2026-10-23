import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { listPulseEvents, PULSE_LIMIT } from "@/lib/pulse";
import type { PulseEvent } from "@/lib/pulse";

// Cockpit pulse lane (THE REDO J07 — k-plex dashboard stage-04 absorbed
// into the J01 viewer): the platform pulse feed, a pure read of the
// vault's Daily/pulse/*.md (stage-02 C2 contract, byte-parity parse
// with the stage-03 renderer). Newest-first; each event carries its
// receipt path so the sidebar row is tappable. Same-origin only — the
// cockpit never iframes the old :8135 surface for this. Read-only.

export const dynamic = "force-dynamic";

function vaultDir(): string {
  return process.env.MWP_VAULT || "/Users/silverhawk/GitHub/MWP";
}

export type CockpitPulsePayload = {
  events: PulseEvent[];
  generated: string;
};

export async function GET() {
  try {
    const dir = path.join(vaultDir(), "Daily", "pulse");
    // Unreadable vault -> 503, same law as the board lane: a missing
    // feed and an empty feed must never look the same.
    if (!fs.existsSync(dir)) {
      return NextResponse.json(
        { error: "pulse dir not found" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const payload: CockpitPulsePayload = {
      events: listPulseEvents(dir, { prefix: "Daily/pulse", limit: PULSE_LIMIT }),
      generated: new Date().toISOString(),
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
