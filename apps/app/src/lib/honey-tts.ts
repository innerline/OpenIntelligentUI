// Honey voice output — the cockpit's half of the iPhone voice contract
// (MWP kanban/device-input-matrix, owner directive 2026-10-18: "iPhone
// is using chat to TTS and STT").
//
// HISTORY / RULING: this lane was built four times on the browser's
// speechSynthesis (primer, chunking, explicit voice pick, visible
// errors) and stayed SILENT on the owner's phone every time
// (2026-10-20, speaking=true, zero audio). Owner ruling: keep it
// simple — server-side voice. All speechSynthesis code is REMOVED,
// not left dormant: nothing regresses to a proven-dead path.
//
// The lane now: Honey's completed reply is rendered SERVER-side by the
// Studio's native `say` CLI (POST /api/cockpit/voice/render → an .m4a
// cached by text hash), and played in the browser as a voice note.
//
// Three modes persist at localStorage `honey-tts-mode` (the same lane
// as the device pin; corrupt values are ignored, not trusted):
//   auto   — on a phone-tagged run the completed reply renders and
//            auto-plays (best effort); non-phone devices stay silent
//   manual — a play button rides every assistant message on ANY
//            device; tapping renders on demand and plays
//   off    — never renders, never plays, no buttons
//
// iOS posture (the whole point of the redesign):
//   • Autoplay outside a user gesture is blocked — so the send tap
//     itself unlocks the shared Audio element SYNCHRONOUSLY
//     (unlockVoiceAudio, hooked at engine-chat's captured document
//     pointerdown, which fires inside the tap before the send
//     handler): play the 50ms silent-WAV data URI, pause inside the
//     same gesture, reset src. Digital silence — not a volume-0
//     trick: iOS ignores HTMLAudio.volume, and the zero-gain session
//     pin killed the speechSynthesis lane. iOS registers the element
//     (and the page's audio session) as gesture-unlocked the moment
//     play() runs in the handler, so the later src swap + play() —
//     after the render completes asynchronously — is permitted.
//   • Without an unlock (programmatic runs: deep links), or when the
//     engine still refuses the play, the note simply lands ready and
//     the ▶ chip on the reply stays as tap-to-play. Blocked autoplay
//     is expected behavior, NOT an error.
//   • A new run (or the stop chip, or hiding the tab) stops playback —
//     Honey never talks over herself. cancelSpeech pauses but never
//     load()s the element: load() re-locks it on iOS Safari, and it
//     fires between every send tap's unlock and the reply's play.
//
// Errors are NEVER silent: render failures reach subscribeTtsErrors
// (the cockpit's TtsErrorChip) and the reply's own chip states
// "voice render failed".

import type { OwnerDevice } from "@/lib/owner-device";

export type TtsMode = "auto" | "manual" | "off";

export const TTS_MODES: readonly TtsMode[] = ["auto", "manual", "off"];

// localStorage key holding the owner's voice-output choice (the mode
// chip writes it).
export const HONEY_TTS_MODE_KEY = "honey-tts-mode";

// Window event fired after the mode changes so chips and message
// buttons re-render without a remount (same pattern as
// OWNER_DEVICE_CHANGED_EVENT; localStorage's own `storage` event only
// reaches other tabs).
export const HONEY_TTS_MODE_CHANGED_EVENT = "honey-tts-mode-changed";

// The server owns the spoken cap (~2000 chars); the client just keeps
// the POST payload sane.
export const VOICE_REQUEST_CAP_CHARS = 4000;

// How long the cockpit's error chip stays up before fading (the
// failure is visible, not sticky).
export const TTS_ERROR_FADE_MS = 12_000;

export function isTtsMode(value: unknown): value is TtsMode {
  return (
    typeof value === "string" &&
    (TTS_MODES as readonly string[]).includes(value)
  );
}

export function getTtsMode(): TtsMode {
  if (typeof window === "undefined") return "auto";
  try {
    const raw = window.localStorage.getItem(HONEY_TTS_MODE_KEY);
    return isTtsMode(raw) ? raw : "auto"; // unset or corrupt → the default
  } catch {
    return "auto"; // storage blocked (private mode): the default answers
  }
}

export function setTtsMode(mode: TtsMode): void {
  try {
    window.localStorage.setItem(HONEY_TTS_MODE_KEY, mode);
  } catch {
    // storage blocked: the event below still updates this mount
  }
  window.dispatchEvent(new Event(HONEY_TTS_MODE_CHANGED_EVENT));
}

// Auto mode voices ONLY phone-tagged runs — laptop/ipad/studio get the
// silent reading surface unless the owner switched to manual.
export function shouldAutoSpeak(mode: TtsMode, device: OwnerDevice): boolean {
  return mode === "auto" && device === "phone";
}

// Markdown → speakable text. Code is not speech (fences drop, inline
// code unwraps); links speak their text, not their URLs; headings,
// list markers, quotes and emphasis unwrap. The adapter already
// strips the VISUAL machine line server-side (slice 2), so it never
// reaches here. The server sanitizes + caps the result.
export function cleanForSpeech(raw: string): string {
  return raw
    .replace(/```[\s\S]*?(```|$)/g, " ") // fenced code blocks
    .replace(/~~~[\s\S]*?(~~~|$)/g, " ") // tilde fences
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images → text
    .replace(/`([^`]*)`/g, "$1") // inline code → content
    .replace(/^\s{0,3}(#{1,6})\s+/gm, " ") // heading markers
    .replace(/^\s{0,3}>\s?/gm, "") // blockquote markers
    .replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, " ") // horizontal rules
    .replace(/^\s*[-:|][-\s:|]*$/gm, " ") // table separator rows
    .replace(/^\s*[-*+]\s+/gm, "") // bullet markers
    .replace(/^\s*\d{1,3}[.)]\s+/gm, "") // ordered-list markers
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2") // bold
    .replace(/(\*)(?=\S)([\s\S]*?\S)\*/g, "$2") // *italics*
    .replace(/(^|[^\w\\])_([^_]+)_(?=[^\w]|$)/gm, "$1$2") // _italics_ at word boundaries only (snake_case stays)
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1") // strikethrough
    .replace(/<[^>]+>/g, " ") // stray HTML tags
    .replace(/\|/g, " ") // table pipes
    .replace(/\s+/g, " ")
    .trim();
}

// --- voice-note state (the per-reply chip listens) ---

export type VoiceNoteState =
  | { status: "rendering" }
  | { status: "ready"; url: string }
  | { status: "failed"; message: string };

const voiceNotes = new Map<string, VoiceNoteState>();
const voiceNoteListeners = new Map<string, Set<(s: VoiceNoteState) => void>>();

function publishVoiceNote(messageId: string, state: VoiceNoteState): void {
  voiceNotes.set(messageId, state);
  for (const listener of voiceNoteListeners.get(messageId) ?? []) listener(state);
}

export function getVoiceNote(messageId: string): VoiceNoteState | null {
  return voiceNotes.get(messageId) ?? null;
}

export function subscribeVoiceNote(
  messageId: string,
  listener: (state: VoiceNoteState) => void,
): () => void {
  let set = voiceNoteListeners.get(messageId);
  if (!set) {
    set = new Set();
    voiceNoteListeners.set(messageId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

// --- playback state (the stop chip listens) ---

const speakingListeners = new Set<(active: boolean) => void>();
let speakingNow = false;

function setSpeaking(active: boolean): void {
  speakingNow = active;
  for (const listener of speakingListeners) listener(active);
}

export function subscribeSpeaking(
  listener: (active: boolean) => void,
): () => void {
  speakingListeners.add(listener);
  return () => {
    speakingListeners.delete(listener);
  };
}

export function isSpeaking(): boolean {
  return speakingNow;
}

// --- voice errors (the cockpit renders them — no silent failures) ---

export interface TtsError {
  type: string;
  message: string;
}

const ttsErrorListeners = new Set<(error: TtsError) => void>();

export function subscribeTtsErrors(
  listener: (error: TtsError) => void,
): () => void {
  ttsErrorListeners.add(listener);
  return () => {
    ttsErrorListeners.delete(listener);
  };
}

function reportTtsError(type: string, message: string): void {
  for (const listener of ttsErrorListeners) listener({ type, message });
}

// --- the shared Audio element ---
//
// ONE element for the whole page session, created inside the owner's
// send-tap gesture (unlockVoiceAudio). iOS unlocks the element/session
// in the gesture; every later playback swaps src on the same element.
// jsdom has no Audio — guarded, so tests stub it.

type VoiceAudio = HTMLAudioElement & {
  play: () => Promise<void> | void;
};

let voiceAudio: VoiceAudio | null = null;
let voiceAudioUnlocked = false;

// Digital silence, ~50ms, 8-bit mono WAV as a data URI — built here
// rather than pasted, so no transcription error can corrupt it. NOT
// volume zero: iOS ignores HTMLAudio.volume, and the gain-pin bug
// that killed the speechSynthesis lane cannot happen to file content
// that is silent samples at normal gain.
const SILENT_PRIMER_URI = (() => {
  try {
    const sr = 8000;
    const n = Math.floor(sr * 0.05); // 400 samples of digital silence
    const wav = new Uint8Array(44 + n);
    const ascii = (o: number, t: string) => {
      for (let i = 0; i < t.length; i++) wav[o + i] = t.charCodeAt(i);
    };
    const u32 = (o: number, v: number) => {
      wav[o] = v & 0xff;
      wav[o + 1] = (v >>> 8) & 0xff;
      wav[o + 2] = (v >>> 16) & 0xff;
      wav[o + 3] = (v >>> 24) & 0xff;
    };
    const u16 = (o: number, v: number) => {
      wav[o] = v & 0xff;
      wav[o + 1] = (v >>> 8) & 0xff;
    };
    ascii(0, "RIFF");
    u32(4, 36 + n);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    u32(16, 16); // PCM chunk size
    u16(20, 1); // format = PCM
    u16(22, 1); // mono
    u32(24, sr);
    u32(28, sr); // byte rate (8-bit mono = sr)
    u16(32, 1); // block align
    u16(34, 8); // bits per sample
    ascii(36, "data");
    u32(40, n);
    wav.fill(128, 44); // 8-bit silence is the midpoint, not zero
    let bin = "";
    for (let i = 0; i < wav.length; i++) bin += String.fromCharCode(wav[i]);
    return `data:audio/wav;base64,${btoa(bin)}`;
  } catch {
    return ""; // no btoa in this environment: chips answer without a primer
  }
})();

function makeAudioElement(): VoiceAudio | null {
  if (typeof Audio === "undefined") return null; // jsdom / SSR
  try {
    const el = new Audio() as VoiceAudio;
    return el;
  } catch {
    return null;
  }
}

// iOS unlock (the classic pattern): called SYNCHRONOUSLY inside the
// send-tap gesture — engine-chat hooks the captured document
// pointerdown, which fires inside the tap before the send handler.
// Set the silent primer src, play(), pause(), reset src: iOS
// registers the element as gesture-unlocked the instant play() runs
// in the handler, so the later src swap + play() — when the reply's
// render completes asynchronously — is permitted. Re-runs on every
// tap (idempotent, ~free): anything that re-locked the element (an
// engine reset, a stray error) is healed by the next send tap, which
// always precedes the reply it should auto-play. Off mode never
// unlocks. A note already playing means the element is unlocked AND
// in use — the unlock must never clobber playback. Failure is
// swallowed — a refused unlock only means autoplay falls back to the
// chip, whose tap is a gesture of its own.
export function unlockVoiceAudio(): void {
  if (getTtsMode() === "off") return;
  const el = voiceAudio ?? makeAudioElement();
  if (!el) return;
  voiceAudio = el;
  if (!el.paused) return; // in use = already unlocked; don't clobber
  try {
    if (SILENT_PRIMER_URI) el.src = SILENT_PRIMER_URI;
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
    el.pause(); // land the stop inside the same gesture
    el.removeAttribute("src"); // reset src — silence dropped, element kept
    voiceAudioUnlocked = true;
  } catch {
    // refused: the element stays locked — the chip answers by tap
  }
}

function ensureVoiceAudio(): VoiceAudio | null {
  const el = voiceAudio ?? makeAudioElement();
  if (el) voiceAudio = el;
  return el;
}

// Play a rendered voice note on the shared element. Outside a gesture
// this is BEST-EFFORT: iOS may reject the play (the send-tap unlock
// usually prevents that); the rejection is swallowed because the chip on
// the reply is the designed tap-to-play fallback, not an error. Real
// element errors (decode/network) ARE reported — never silent.
export function playVoiceNote(url: string): void {
  if (getTtsMode() === "off") return;
  const el = ensureVoiceAudio();
  if (!el) return;
  el.onended = () => setSpeaking(false);
  el.onerror = () => {
    setSpeaking(false);
    reportTtsError("voice-playback-failed", "the voice note would not play");
  };
  try {
    el.src = url;
    const p = el.play();
    setSpeaking(true);
    if (p && typeof p.catch === "function") {
      p.catch(() => setSpeaking(false)); // autoplay blocked — chip answers
    }
  } catch {
    setSpeaking(false); // refused outright — chip answers
  }
}

// Stop immediately — the stop chip, a new run, and page-hide all call
// this so a stale voice never talks over the next reply. Pauses and
// drops the src but NEVER calls load(): load() resets the element and
// re-locks it on iOS Safari, and this runs on every new run — between
// the send tap's unlock and the reply's auto-play.
export function cancelSpeech(): void {
  const el = voiceAudio;
  if (el) {
    try {
      el.pause();
      el.removeAttribute("src"); // drop the content, keep the element
    } catch {
      // engines can throw on odd states
    }
  }
  setSpeaking(false);
}

// --- rendering ---

export interface VoiceRenderResponse {
  url: string;
  cached: boolean;
  voice?: string | null;
}

// Ask the Studio to render one reply. Never rejects: every failure is
// published on the message's chip (status failed) AND the error lane
// (TtsErrorChip) — the four silent-build incident is the reason this
// lane exists. Returns the final state so callers can chain playback.
export async function requestVoiceNote(
  messageId: string,
  raw: string,
): Promise<VoiceNoteState> {
  const text = cleanForSpeech(raw).slice(0, VOICE_REQUEST_CAP_CHARS);
  if (!text) {
    const failed: VoiceNoteState = { status: "failed", message: "nothing to speak" };
    publishVoiceNote(messageId, failed);
    return failed;
  }
  const existing = voiceNotes.get(messageId);
  if (existing && existing.status !== "failed") return existing; // already asked
  publishVoiceNote(messageId, { status: "rendering" });
  let state: VoiceNoteState;
  try {
    const res = await fetch("/api/cockpit/voice/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, sessionHint: messageId }),
    });
    if (!res.ok) {
      throw new Error(`render answered ${res.status}`);
    }
    const body = (await res.json()) as VoiceRenderResponse;
    if (typeof body?.url !== "string" || !body.url) {
      throw new Error("render answered without a url");
    }
    state = { status: "ready", url: body.url };
  } catch (e) {
    state = {
      status: "failed",
      message: e instanceof Error ? e.message : "render failed",
    };
    reportTtsError("voice-render-failed", state.message);
  }
  publishVoiceNote(messageId, state);
  return state;
}

// The phone-tagged auto-voice entry: engine-chat's RUN_FINISHED hands
// the completed reply, the run's device tag, and the streamed message
// id here. Render, then play — but ONLY on the gesture-unlocked
// shared element (the send tap unlocked it synchronously before the
// run). Without an unlock — a programmatic run, a keyboard-only
// submit — iOS refuses programmatic play; the note lands ready
// anyway, so the ▶ chip on the reply is the designed tap-to-play
// fallback. Manual mode's chip tap is a gesture of its own and plays
// through playVoiceNote un-gated.
export function maybeAutoVoiceNote(
  raw: string,
  device: OwnerDevice,
  messageId: string | null,
): void {
  if (!shouldAutoSpeak(getTtsMode(), device)) return;
  const text = cleanForSpeech(raw);
  if (!text) return;
  // Without a streamed message id the chip cannot key to a reply; the
  // text hash still renders + plays, the chip just does not appear.
  const id = messageId ?? `text-${text.length}-${text.slice(0, 64)}`;
  void requestVoiceNote(id, raw).then((state) => {
    if (state.status === "ready" && voiceAudioUnlocked) {
      playVoiceNote(state.url);
    }
  });
}

// Test seam: clear module state between tests (fresh element, chips,
// speaking flag). Nothing outside tests calls this.
export function resetVoiceLaneForTests(): void {
  voiceAudio = null;
  voiceAudioUnlocked = false;
  speakingNow = false;
  voiceNotes.clear();
  voiceNoteListeners.clear();
}
