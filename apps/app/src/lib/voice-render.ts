// Server-side voice rendering for Honey's replies (kanban
// /device-input-matrix, iPhone contract slice: "chat with TTS"). Four
// builds of on-device speechSynthesis stayed silent on the owner's
// phone — this lane bypasses Web Speech entirely: the reply is
// rendered into an .m4a ONCE server-side, the client plays it back as
// a voice note. Two engines, same machinery:
//
//   piper — local neural TTS (piper-tts in apps/app/.piper-venv,
//           voices in runtime/piper/). Fully local, no cloud. Chosen
//           when the override file asks for it ("piper:<model>", e.g.
//           "piper:en_US-amy-medium") AND the binary+model exist;
//           any piper failure falls back to `say` with a warning —
//           never a silent failure, never a missing voice note.
//   say   — the macOS native CLI. The original engine and the
//           fallback; behavior unchanged.
//
//   POST /api/cockpit/voice/render  → lib renders here, returns a URL
//   GET  /api/cockpit/voice/audio   → serves the rendered file
//
// Caching: the file name is a sha256 of (voice, rate, speed, final
// text), so identical replies never re-render. The cache identity
// includes the engine+voice ("piper:en_US-amy-medium" vs a `say`
// voice name) and the speed scale, so piper/say renders never collide
// and neither do 1x and 1.5x renders of the same text. Files older
// than 24h are pruned on each render (best-effort — a prune failure
// never fails a render).

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

// Piper renders locally (measured: ~1.1s cold for two sentences,
// ~2.3s at the full text cap on the Studio) — 30s is a generous
// failure ceiling matching the say posture.
const PIPER_TIMEOUT_MS = 30_000;
const AFCONVERT_TIMEOUT_MS = 10_000;

// Preference order from the slice design; matched against the REAL
// `say -v ?` listing at render time (names are normalized — "Ava
// (Premium)" matches a listed "Ava (Premium)", a bare "Ava" matches
// "Ava (English (US))" too; premium variants win over plain ones).
// No match → the system default voice (no -v flag) — never a novelty
// voice (Bells, Bad News, …).
// Runtime override: first line of apps/app/runtime/voice-override.txt is
// prepended to the preference order at render time — instant voice flips
// without rebuilds (owner voice-pick mechanism, 2026-10-20). A line of
// the form "piper:<model>" selects the piper engine instead (see
// piperOverride). The SECOND line is the speed knob: a piper LENGTH
// SCALE divisor (0.67 ≈ 1.5x faster, smaller = faster; `say` converts
// it to wpm: round(VOICE_RATE_WPM / scale)) — the owner's instant
// speed dial, same no-rebuild posture as the voice line. Speed source,
// first match wins: override line 2 → env HONEY_VOICE_SPEED → 1.0.
// MWP_VOICE_OVERRIDE replaces the file for tests.
function readOverrideLines(): string[] {
  try {
    const raw =
      process.env.MWP_VOICE_OVERRIDE !== undefined
        ? process.env.MWP_VOICE_OVERRIDE
        : fs.readFileSync(
            path.join(process.cwd(), "runtime", "voice-override.txt"),
            "utf8",
          );
    return raw.trim().split("\n");
  } catch {
    return [];
  }
}

function readVoiceOverride(): string | null {
  const v = readOverrideLines()[0];
  return v?.trim() || null;
}

// Speed validity window: a length scale strictly between 0.2 and 3.
// Outside it (garbage, 0, negatives, absurd asks) the candidate is not
// a match and the next source is tried — a bad line never silences or
// chipmunks the voice, it just falls back to normal pacing.
const VOICE_SPEED_SCALE_MIN = 0.2;
const VOICE_SPEED_SCALE_MAX = 3;

function parseSpeedScale(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return null;
  if (n <= VOICE_SPEED_SCALE_MIN || n >= VOICE_SPEED_SCALE_MAX) return null;
  return n;
}

// The effective length scale for this render (1.0 = natural pacing).
export function voiceSpeedScale(): number {
  const fromFile = parseSpeedScale(readOverrideLines()[1]);
  if (fromFile !== null) return fromFile;
  const fromEnv = parseSpeedScale(process.env.HONEY_VOICE_SPEED);
  if (fromEnv !== null) return fromEnv;
  return 1.0;
}

// `say` has no scale flag — the scale becomes words per minute.
function sayRateWpm(scale: number): number {
  return Math.round(VOICE_RATE_WPM / scale);
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

// File identity: voice + rate + speed + final text → identical replies
// share one render regardless of which session asked. The speed scale
// is part of the identity, so a 0.67 rerender of an already-cached 1.0
// reply is a NEW file — the two never collide.
export function voiceFileHash(
  text: string,
  voice: string | null,
  speed: number,
): string {
  return createHash("sha256")
    .update(`${voice ?? "default"}\u0000${VOICE_RATE_WPM}\u0000${speed}\u0000${text}`)
    .digest("hex");
}

// Where renders live. The oiu-app launchd service runs from
// apps/app, so the default is that tree's runtime/ (git-ignored);
// MWP_VOICE_DIR overrides for tests and unusual mounts.
export function voiceDir(): string {
  return process.env.MWP_VOICE_DIR || path.join(process.cwd(), "runtime", "voice");
}

// Where piper voices live: the launchd service runs from apps/app, so
// the default is that tree's runtime/piper/ (git-ignored, like all of
// runtime/); MWP_PIPER_DIR overrides for tests and unusual mounts.
export function piperModelDir(): string {
  return process.env.MWP_PIPER_DIR || path.join(process.cwd(), "runtime", "piper");
}

// The piper CLI from the app-local venv (apps/app/.piper-venv, also
// git-ignored — installed by the voice lane, not pnpm). MWP_PIPER_BIN
// overrides for tests and unusual mounts.
export function piperBin(): string {
  return (
    process.env.MWP_PIPER_BIN || path.join(process.cwd(), ".piper-venv", "bin", "piper")
  );
}

// The override's engine selector: "piper:en_US-amy-medium" →
// "en_US-amy-medium". Anything else (say voice names, blank) → null.
export function piperOverride(): string | null {
  const v = readVoiceOverride();
  if (!v || !v.startsWith("piper:")) return null;
  const model = v.slice("piper:".length).trim();
  return model || null; // a bare "piper:" is not a piper ask
}

// A model is usable when its .onnx AND its .onnx.json sit in the model
// dir. The binary must exist too — a missing piece means the owner
// flipped the override before/after an install; the render falls back
// to `say` with a warning instead of failing.
export function piperAvailable(model: string, deps: VoiceDeps): boolean {
  const onnx = path.join(piperModelDir(), `${model}.onnx`);
  return (
    deps.exists(piperBin()) && deps.exists(onnx) && deps.exists(`${onnx}.json`)
  );
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
  writeFile: (p: string, data: string) => void;
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
  writeFile: (p, data) => fs.writeFileSync(p, data),
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
  voice: string | null; // engine+voice used: "piper:<model>" or the `say -v` name, null = system default
  speed: number; // the length scale the render ran at (1.0 = natural)
}

const inFlight = new Map<string, Promise<VoiceRenderResult>>();

// One render through the shared hash-cache machinery: reuse an
// existing file, dedupe concurrent identical renders (in-flight
// map), prune, and let `speak` do the engine-specific work of
// producing <file> (.m4a). The speed scale rides the hash, so the
// cache is speed-aware end to end.
async function renderVia(
  identity: string | null,
  final: string,
  speed: number,
  deps: VoiceDeps,
  speak: (file: string) => Promise<void>,
): Promise<VoiceRenderResult> {
  const hash = voiceFileHash(final, identity, speed);
  const dir = voiceDir();
  const file = path.join(dir, `${hash}.m4a`);
  const running = inFlight.get(hash);
  if (running) return running;
  const job = (async (): Promise<VoiceRenderResult> => {
    if (deps.exists(file)) {
      return { hash, file, cached: true, voice: identity, speed };
    }
    deps.mkdir(dir);
    await speak(file);
    pruneVoiceFiles(dir, deps);
    return { hash, file, cached: false, voice: identity, speed };
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

// Piper speaks `final` into <file>.m4a: text → temp .txt (the CLI
// takes a file, not an argv string), piper → temp .wav, afconvert →
// the .m4a the audio route serves (AAC ~5x smaller than the wav;
// same container every say render already uses). The speed knob is
// piper's native --length_scale (divisor: 0.67 ≈ 1.5x faster).
// Temps are cleaned up best-effort — a stray temp never fails the
// render.
async function piperSpeak(
  model: string,
  final: string,
  file: string,
  speed: number,
  deps: VoiceDeps,
): Promise<void> {
  const dir = path.dirname(file);
  const txt = path.join(dir, `${path.basename(file)}.txt`);
  const wav = path.join(dir, `${path.basename(file)}.wav`);
  const onnx = path.join(piperModelDir(), `${model}.onnx`);
  deps.writeFile(txt, final);
  try {
    await deps.exec(
      piperBin(),
      ["-m", onnx, "-i", txt, "-f", wav, "--length_scale", String(speed)],
      { timeout: PIPER_TIMEOUT_MS },
    );
    await deps.exec(
      "afconvert",
      ["-f", "m4af", "-d", "aac", "-b", "64000", wav, file],
      { timeout: AFCONVERT_TIMEOUT_MS },
    );
  } finally {
    try {
      deps.unlink(txt);
      deps.unlink(wav);
    } catch {
      // raced away or never written — prune ignores non-.m4a anyway
    }
  }
}

// Render one reply to <dir>/<hash>.m4a, reusing an existing render
// when the hash matches. The piper engine is chosen by the runtime
// override ("piper:<model>"); when piper is unavailable or fails
// mid-render the say lane takes over with a warning — the owner
// always gets a voice note. The speed scale (override line 2 → env
// HONEY_VOICE_SPEED → 1.0) applies to BOTH engines and rides the
// cache identity. Identical concurrent requests share a single
// render (the in-flight map).
export async function renderVoiceFile(
  text: string,
  deps: VoiceDeps = realVoiceDeps,
): Promise<VoiceRenderResult> {
  const final = capVoiceText(sanitizeVoiceText(text));
  if (!final) throw new Error("nothing to speak");
  const speed = voiceSpeedScale();

  const model = piperOverride();
  if (model) {
    if (piperAvailable(model, deps)) {
      try {
        return await renderVia(`piper:${model}`, final, speed, deps, (file) =>
          piperSpeak(model, final, file, speed, deps),
        );
      } catch (e) {
        console.warn(
          `[voice] piper render failed (${e instanceof Error ? e.message : String(e)}) — falling back to say`,
        );
      }
    } else {
      console.warn(
        `[voice] piper binary or model "${model}" missing — falling back to say`,
      );
    }
  }

  const voices = await listSayVoices(deps);
  const voice = pickSayVoice(voices);
  return renderVia(voice, final, speed, deps, (file) =>
    deps.exec(
      "say",
      [
        "-o",
        file,
        "-r",
        String(sayRateWpm(speed)),
        ...(voice ? ["-v", voice] : []),
        "--data-format=aac", // ~3x smaller than say's default ALAC
        final,
      ],
      { timeout: SAY_TIMEOUT_MS },
    ).then(() => undefined),
  );
}

// Test seam: clear the cached voice listing + in-flight map so a test
// injecting deps starts clean.
export function resetVoiceRenderCaches(): void {
  listedVoices = null;
  inFlight.clear();
}
