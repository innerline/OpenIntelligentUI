// Server-side voice rendering for Honey's replies (kanban
// /device-input-matrix, iPhone contract slice: "chat with TTS"). Four
// builds of on-device speechSynthesis stayed silent on the owner's
// phone — this lane bypasses Web Speech entirely: the macOS Studio's
// native `say` CLI renders the reply into an .m4a ONCE, the client
// plays it back as a voice note. Server-only module — no window, no
// "use client".
//
//   POST /api/cockpit/voice/render  → lib renders here, returns a URL
//   GET  /api/cockpit/voice/audio   → serves the rendered file
//
// Caching: the file name is a sha256 of (voice, rate, final text), so
// identical replies never re-render. Files older than 24h are pruned
// on each render (best-effort — a prune failure never fails a render).

import { createHash } from "crypto";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";

// Speech budget: the server owns the cap (defense in depth — the
// client already sends cleaned text, this guards a runaway payload).
// Same tail contract the Web Speech lane had: honest about the cut.
export const VOICE_TEXT_CAP_CHARS = 2000;
const VOICE_CAP_SUFFIX = " Message continues on screen.";

// ~185 wpm — conversational, matches the previous lane's pacing.
export const VOICE_RATE_WPM = 185;

// Rendered notes live 24h; every render sweeps older files.
export const VOICE_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// `say` must answer within this or the render fails visibly.
const SAY_TIMEOUT_MS = 30_000;

// Preference order from the slice design; matched against the REAL
// `say -v ?` listing at render time (names are normalized — "Ava
// (Premium)" matches a listed "Ava (Premium)", a bare "Ava" matches
// "Ava (English (US))" too; premium variants win over plain ones).
// No match → the system default voice (no -v flag) — never a novelty
// voice (Bells, Bad News, …).
// Runtime override: first line of apps/app/runtime/voice-override.txt is
// prepended to the preference order at render time — instant voice flips
// without rebuilds (owner voice-pick mechanism, 2026-10-20).
function readVoiceOverride(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const f = path.join(process.cwd(), "runtime", "voice-override.txt");
    const v = fs.readFileSync(f, "utf8").trim().split("\n")[0];
    return v || null;
  } catch {
    return null;
  }
}

export const PREFERRED_SAY_VOICES: readonly string[] = [
  "Ava (Premium)",
  "Samantha (Premium)",
  "Ava",
  "Samantha",
];

export interface SayVoice {
  name: string; // the exact token `say -v` accepts
  locale: string; // e.g. en_US
}

// Parse `say -v ?` output: "<name with spaces> <locale>  # comment".
// The name may itself contain spaces and parentheses ("Samantha
// (English (US))"), so the locale token + trailing comment anchor the
// match; junk lines (headers, blanks) never parse.
export function parseSayVoices(listing: string): SayVoice[] {
  const voices: SayVoice[] = [];
  for (const line of listing.split("\n")) {
    const m = line.match(/^(\S.*?)\s+([a-z]{2}_[A-Z]{2}(?:-[a-zA-Z]+)?)\s+#/);
    if (m && m[1] && m[2]) voices.push({ name: m[1].trim(), locale: m[2] });
  }
  return voices;
}

// "Ava (Premium)" → { base: "Ava", premium: true };
// "Samantha (English (US))" → { base: "Samantha", premium: false }.
// The strip is greedy so NESTED parentheticals ("(English (US))")
// come off whole — a non-greedy match would stop at the inner ")".
function voiceKey(name: string): { base: string; premium: boolean } {
  return {
    base: name.replace(/\s*\(.*\)\s*$/, "").trim(),
    premium: /\(\s*Premium\s*\)/.test(name),
  };
}

// Best voice from the listing, or null for the system default. Only
// English locales are eligible — Honey's replies are English.
export function pickSayVoice(voices: readonly SayVoice[]): string | null {
  const en = voices.filter((v) => v.locale.toLowerCase().startsWith("en"));
  const override = readVoiceOverride();
  if (override) {
    const want = voiceKey(override);
    const hit = en.find((v) => {
      const have = voiceKey(v.name);
      return have.base === want.base && have.premium === want.premium;
    });
    if (hit) return hit.name;
    // Override names a voice that isn't installed — fall through to defaults
    // rather than refusing to speak.
  }
  for (const preferred of PREFERRED_SAY_VOICES) {
    const want = voiceKey(preferred);
    const hit = en.find((v) => {
      const have = voiceKey(v.name);
      return have.base === want.base && have.premium === want.premium;
    });
    if (hit) return hit.name;
  }
  return null;
}

// Strip control characters (keep whitespace structure), collapse runs.
// Defense in depth — the client already sends cleaned plain text.
export function sanitizeVoiceText(raw: string): string {
  return raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Cap at VOICE_TEXT_CAP_CHARS on a sentence boundary when one sits in
// the second half of the budget (word boundary next, hard cut last),
// appending the on-screen tail — same contract the spoken lane had.
export function capVoiceText(text: string): string {
  if (text.length <= VOICE_TEXT_CAP_CHARS) return text;
  const head = text.slice(0, VOICE_TEXT_CAP_CHARS);
  const sentenceEnd = Math.max(
    head.lastIndexOf("."),
    head.lastIndexOf("!"),
    head.lastIndexOf("?"),
    head.lastIndexOf("…"),
    head.lastIndexOf(";"),
    head.lastIndexOf(":"),
  );
  const wordEnd = head.lastIndexOf(" ");
  const cut =
    sentenceEnd > VOICE_TEXT_CAP_CHARS / 2
      ? text.slice(0, sentenceEnd + 1).trim()
      : wordEnd > VOICE_TEXT_CAP_CHARS / 2
        ? text.slice(0, wordEnd).trim()
        : head.trim();
  return cut + VOICE_CAP_SUFFIX;
}

// File identity: voice + rate + final text → identical replies share
// one render regardless of which session asked.
export function voiceFileHash(text: string, voice: string | null): string {
  return createHash("sha256")
    .update(`${voice ?? "default"}\u0000${VOICE_RATE_WPM}\u0000${text}`)
    .digest("hex");
}

// Where renders live. The oiu-app launchd service runs from
// apps/app, so the default is that tree's runtime/ (git-ignored);
// MWP_VOICE_DIR overrides for tests and unusual mounts.
export function voiceDir(): string {
  return process.env.MWP_VOICE_DIR || path.join(process.cwd(), "runtime", "voice");
}

// Injectable process surface — tests swap these; production binds the
// real ones. Keeping them in one object keeps the module honest about
// every side effect it performs.
export interface VoiceDeps {
  exec: (
    file: string,
    args: string[],
    options: { timeout: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  exists: (p: string) => boolean;
  stat: (p: string) => { mtimeMs: number };
  readdir: (p: string) => string[];
  unlink: (p: string) => void;
  mkdir: (p: string) => void;
}

export const realVoiceDeps: VoiceDeps = {
  exec: (file, args, options) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        options,
        (err: Error | null, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        },
      );
    }),
  exists: (p) => fs.existsSync(p),
  stat: (p) => fs.statSync(p),
  readdir: (p) => fs.readdirSync(p),
  unlink: (p) => fs.unlinkSync(p),
  mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
};

let listedVoices: Promise<readonly SayVoice[]> | null = null;

// `say -v ?` once per process — the installed voice set does not
// change under us. Failure → empty listing → system default voice.
function listSayVoices(deps: VoiceDeps): Promise<readonly SayVoice[]> {
  if (!listedVoices) {
    listedVoices = deps
      .exec("say", ["-v", "?"], { timeout: 10_000 })
      .then((r) => parseSayVoices(r.stdout))
      .catch(() => [] as SayVoice[]);
  }
  return listedVoices;
}

// Drop files older than VOICE_FILE_MAX_AGE_MS. Best-effort by design:
// an unreadable stat or stubborn unlink is skipped, never thrown —
// pruning must not take the render down with it.
export function pruneVoiceFiles(
  dir: string,
  deps: VoiceDeps,
  now: number = Date.now(),
): void {
  let entries: string[];
  try {
    entries = deps.readdir(dir);
  } catch {
    return; // nothing there yet
  }
  for (const entry of entries) {
    if (!entry.endsWith(".m4a")) continue;
    const p = path.join(dir, entry);
    try {
      if (now - deps.stat(p).mtimeMs > VOICE_FILE_MAX_AGE_MS) deps.unlink(p);
    } catch {
      // raced away or unreadable — the next render tries again
    }
  }
}

export interface VoiceRenderResult {
  hash: string; // file basename (hex, no extension)
  file: string; // absolute path
  cached: boolean;
  voice: string | null; // the `say -v` name used, null = system default
}

const inFlight = new Map<string, Promise<VoiceRenderResult>>();

// Render one reply to <dir>/<hash>.m4a with `say`, reusing an existing
// render when the hash matches. Identical concurrent requests share a
// single `say` invocation (the in-flight map) so the same file is
// never written twice at once.
export async function renderVoiceFile(
  text: string,
  deps: VoiceDeps = realVoiceDeps,
): Promise<VoiceRenderResult> {
  const final = capVoiceText(sanitizeVoiceText(text));
  if (!final) throw new Error("nothing to speak");
  const voices = await listSayVoices(deps);
  const voice = pickSayVoice(voices);
  const hash = voiceFileHash(final, voice);
  const dir = voiceDir();
  const file = path.join(dir, `${hash}.m4a`);
  const running = inFlight.get(hash);
  if (running) return running;
  const job = (async (): Promise<VoiceRenderResult> => {
    if (deps.exists(file)) {
      return { hash, file, cached: true, voice };
    }
    deps.mkdir(dir);
    await deps.exec(
      "say",
      [
        "-o",
        file,
        "-r",
        String(VOICE_RATE_WPM),
        ...(voice ? ["-v", voice] : []),
        "--data-format=aac", // ~3x smaller than say's default ALAC
        final,
      ],
      { timeout: SAY_TIMEOUT_MS },
    );
    pruneVoiceFiles(dir, deps);
    return { hash, file, cached: false, voice };
  })()
    .catch((e: unknown) => {
      throw e instanceof Error ? e : new Error(String(e));
    })
    .finally(() => {
      inFlight.delete(hash);
    });
  inFlight.set(hash, job);
  return job;
}

// Test seam: clear the cached voice listing + in-flight map so a test
// injecting deps starts clean.
export function resetVoiceRenderCaches(): void {
  listedVoices = null;
  inFlight.clear();
}
