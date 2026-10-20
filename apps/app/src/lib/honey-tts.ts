// Honey TTS — the cockpit's half of the iPhone voice contract
// (MWP kanban/device-input-matrix, owner directive 2026-10-18: "iPhone
// is using chat to TTS and STT"). When a chat run's device tag is
// `phone`, Honey's completed reply is SPOKEN aloud through the Web
// Speech API — no external TTS service, everything stays on-device.
//
// Three modes persist at localStorage `honey-tts-mode` (the same lane
// as the device pin; corrupt values are ignored, not trusted):
//   auto   — speak automatically on phone-tagged runs (the default;
//            non-phone devices stay silent)
//   manual — never auto-speak; a play button rides every assistant
//            message on ANY device
//   off    — never speak, no buttons
//
// iOS Safari quirks this module owns:
//   1. speechSynthesis refuses to speak unless speak() ran once inside
//      a user gesture — unlockSpeech() is called from a pointerdown
//      (the send-button tap counts) and primes it with a near-silent
//      utterance. The primer must NOT be volume 0: iOS pins the audio
//      session at the primer's gain, so a zero-gain primer leaves
//      every later utterance SILENT while speechSynthesis.speaking
//      still reports true (owner phone, 2026-10-20). It primes at
//      0.01 — inaudible but nonzero — and cancels itself once done to
//      reset the session; every real utterance sets volume = 1.
//   2. long utterances stall mid-speech on iOS — replies are chunked
//      into sentence-boundary pieces of ≤ SPEECH_CHUNK_CHARS and queued;
//      short utterances chain through the browser's native queue.
//   3. a new run (or the stop chip) cancels whatever is still speaking.
//   4. the SYSTEM-DEFAULT voice can fail silently on iOS Safari (owner
//      phone 2026-10-20, after the primer fix: speaking=true, no
//      audio). Every reply picks an explicit voice instead — see
//      pickVoice() — and utterance errors are reported to subscribers
//      (subscribeTtsErrors) so the cockpit can show them: no silent
//      failures.

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

// Spoken budget: the first ~700 characters, then the tail note. Phone
// replies are short by contract (the device line tells the engine so),
// so this mostly guards a runaway reply.
export const SPEECH_CAP_CHARS = 700;
const SPEECH_CAP_SUFFIX = " Message continues on screen.";

// iOS stalls on long single utterances; short chained ones survive.
export const SPEECH_CHUNK_CHARS = 200;

// Voice picking (quirk 4). Replies are English; voices are matched by
// lang prefix, on-device ones preferred, then the known-good iOS
// names in the order the owner's phone answered best.
export const SPEECH_LANG_PREFIX = "en";
const PREFERRED_VOICE_NAMES: readonly string[] = [
  "Samantha",
  "Ava",
  "Allison",
  "Nick",
];

// Chrome/iOS load the voice list asynchronously — getVoices() returns
// [] until voiceschanged fires (and some engines never fire it), so
// the picker re-checks once after this long even without the event.
const VOICES_WAIT_MS = 1500;

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

// Auto mode speaks ONLY phone-tagged runs — laptop/ipad/studio get the
// silent reading surface unless the owner switched to manual.
export function shouldAutoSpeak(mode: TtsMode, device: OwnerDevice): boolean {
  return mode === "auto" && device === "phone";
}

// Markdown → speakable text. Code is not speech (fences drop, inline
// code unwraps); links speak their text, not their URLs; headings,
// list markers, quotes and emphasis unwraps. The adapter already
// strips the VISUAL machine line server-side (slice 2), so it never
// reaches here.
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

// Speak the first ~SPEECH_CAP_CHARS, cutting at a sentence end when
// one sits in the second half of the budget (falling back to a word
// boundary, then a hard cut) and appending the on-screen tail note.
export function capForSpeech(text: string): string {
  if (text.length <= SPEECH_CAP_CHARS) return text;
  const head = text.slice(0, SPEECH_CAP_CHARS);
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
    sentenceEnd > SPEECH_CAP_CHARS / 2
      ? text.slice(0, sentenceEnd + 1).trim()
      : wordEnd > SPEECH_CAP_CHARS / 2
        ? text.slice(0, wordEnd).trim()
        : head.trim();
  return cut + SPEECH_CAP_SUFFIX;
}

// Sentence-boundary chunks of ≤ SPEECH_CHUNK_CHARS (no lookbehind —
// older Safari throws at regex-compile time). Oversized sentences
// hard-split at word boundaries. Joining the chunks with a space
// reproduces the text.
export function chunkForSpeech(text: string): string[] {
  if (!text.trim()) return [];
  const sentences = text.replace(/([.!?…])\s+/g, "$1\u0000").split("\u0000");
  const pieces: string[] = [];
  for (const sentence of sentences) {
    let s = sentence.trim();
    if (!s) continue;
    while (s.length > SPEECH_CHUNK_CHARS) {
      let cut = s.lastIndexOf(" ", SPEECH_CHUNK_CHARS);
      if (cut <= 0) cut = SPEECH_CHUNK_CHARS; // monster word: hard cut
      const piece = s.slice(0, cut).trim();
      if (piece) pieces.push(piece);
      s = s.slice(cut).trim();
    }
    if (s) pieces.push(s);
  }
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks[chunks.length - 1];
    if (last && last.length + 1 + piece.length <= SPEECH_CHUNK_CHARS) {
      chunks[chunks.length - 1] = last + " " + piece;
    } else {
      chunks.push(piece);
    }
  }
  return chunks;
}

// --- speaking state (the stop chip listens) ---

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

function getSynth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return "speechSynthesis" in window ? window.speechSynthesis : null;
}

// Pick the voice a reply is spoken with, best-first: (a) voices whose
// lang matches the reply language prefix, (b) localService ones among
// them, (c) the known-good iOS names in order, then any other
// matching voice, (d) any voice at all when none match the language.
// null = nothing to pick from — leave utterance.voice unset and let
// the system default answer; speech is never blocked on the picker.
export function pickVoice(
  voices: readonly SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  const langMatches = voices.filter((v) =>
    (v.lang ?? "").toLowerCase().startsWith(SPEECH_LANG_PREFIX),
  );
  const local = langMatches.filter((v) => v.localService);
  const pool = local.length ? local : langMatches;
  for (const name of PREFERRED_VOICE_NAMES) {
    const hit = pool.find((v) => v.name === name);
    if (hit) return hit;
  }
  return pool[0] ?? voices[0] ?? null;
}

// The picked voice for the CURRENT synth, cached. getVoices() is
// usually empty on the first call (iOS/Chrome load the list late), so
// the pick is retried when voiceschanged fires — or once after
// VOICES_WAIT_MS on engines that never fire it. Keyed on the synth
// instance: a fresh engine (new page, remount) re-picks from scratch.
let voicePick: {
  synth: SpeechSynthesis;
  voice: SpeechSynthesisVoice | null;
} | null = null;

function ensureVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
  if (voicePick?.synth === synth) return voicePick.voice;
  voicePick = { synth, voice: null };
  const readVoices = (): readonly SpeechSynthesisVoice[] => {
    try {
      const list =
        typeof synth.getVoices === "function" ? synth.getVoices() : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const repick = () => {
    if (voicePick?.synth !== synth || voicePick.voice) return;
    voicePick.voice = pickVoice(readVoices());
  };
  repick(); // usually empty on iOS — fine, never blocks speech
  if (!voicePick.voice) {
    if (typeof synth.addEventListener === "function") {
      try {
        synth.addEventListener("voiceschanged", repick);
      } catch {
        // not an EventTarget after all: the timeout below still re-picks
      }
    }
    setTimeout(repick, VOICES_WAIT_MS); // backstop — some engines never fire
  }
  return voicePick.voice;
}

// --- voice errors (the cockpit renders them — no silent failures) ---

// Deliberate stops (the stop chip, a new run's reset) also fire
// onerror on some engines with these types — not failures, never
// surfaced to the owner.
const BENIGN_ERROR_TYPES: ReadonlySet<string> = new Set([
  "canceled",
  "interrupted",
]);

// How long the cockpit's error chip stays up before fading (the
// failure is visible, not sticky).
export const TTS_ERROR_FADE_MS = 12_000;

// What an utterance error hands the cockpit: the engine's error type
// ("synthesis-failed", "voice-unavailable", …) or "unknown", plus the
// engine's message when it gave one.
export interface TtsError {
  type: string;
  message: string;
}

const ttsErrorListeners = new Set<(error: TtsError) => void>();

// Subscribe to spoken-reply failures — the cockpit's error chip.
// Same grammar as subscribeSpeaking.
export function subscribeTtsErrors(
  listener: (error: TtsError) => void,
): () => void {
  ttsErrorListeners.add(listener);
  return () => {
    ttsErrorListeners.delete(listener);
  };
}

function readErrorEvent(event: unknown): TtsError {
  if (event && typeof event === "object") {
    const { error, message } = event as { error?: unknown; message?: unknown };
    return {
      type: typeof error === "string" && error ? error : "unknown",
      message: typeof message === "string" ? message : "",
    };
  }
  return { type: "unknown", message: "" };
}

function reportTtsError(event: unknown): void {
  const error = readErrorEvent(event);
  if (BENIGN_ERROR_TYPES.has(error.type)) return; // our own cancel
  for (const listener of ttsErrorListeners) listener(error);
}

// Speak one reply: clean → cap → chunk → queue. Mode off never speaks
// (the guard lives here so every entry path inherits it). The session
// is reset (cancel) before every reply — iOS audio sessions can carry
// stale gain/queue state, so nothing is inherited — and new speech
// replaces whatever is still playing.
export function speakReply(raw: string): void {
  cancelSpeech(); // unconditional reply-start reset of the audio session
  if (getTtsMode() === "off") return;
  const synth = getSynth();
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") return;
  const text = capForSpeech(cleanForSpeech(raw));
  if (!text) return;
  const chunks = chunkForSpeech(text);
  // Quirk 4: the system default can be unplayable — pin an explicit
  // voice when one is loaded; null (list still empty) means the system
  // default, which still beats not speaking at all.
  const voice = ensureVoice(synth);
  let queued = false;
  chunks.forEach((chunk, i) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.volume = 1; // explicit — never inherit the primer's 0.01
    if (voice) utterance.voice = voice;
    if (i === chunks.length - 1) {
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = (event) => {
        reportTtsError(event); // visible — never a silent failure again
        setSpeaking(false);
      };
    } else {
      // a failed mid-reply chunk aborts the whole playback cleanly
      utterance.onerror = (event) => {
        reportTtsError(event);
        cancelSpeech();
      };
    }
    try {
      synth.speak(utterance);
      queued = true;
    } catch {
      // refused (e.g. no voices yet): the next reply tries again
    }
  });
  setSpeaking(queued);
}

// Stop immediately — the stop chip, a new run, and page-hide all call
// this so a stale voice never talks over the next reply.
export function cancelSpeech(): void {
  const synth = getSynth();
  try {
    synth?.cancel();
  } catch {
    // some engines throw on cancel with nothing queued
  }
  setSpeaking(false);
}

// The phone-tagged auto-speak entry: engine-chat's RUN_FINISHED hands
// the completed reply and the run's device tag here.
export function maybeAutoSpeak(raw: string, device: OwnerDevice): void {
  if (!shouldAutoSpeak(getTtsMode(), device)) return;
  speakReply(raw);
}

// iOS quirk 1: speechSynthesis ignores speak() until it has been
// called once inside a user gesture. engine-chat wires this to a
// captured pointerdown (the send-button tap counts) — a near-silent
// 0.01-volume primer unlocks the engine for the session. A volume-0
// primer is NOT silent-but-safe on iOS: the audio session keeps the
// primer's zero gain and later utterances play mute — so the primer
// carries nonzero gain, and once it completes (or errors) it cancels
// itself to hand back a clean audio session. That trailing cancel
// skips a reply that started speaking in the same breath (manual
// mode's play button races the primer).
let speechUnlocked = false;

export function unlockSpeech(): void {
  if (speechUnlocked || getTtsMode() === "off") return; // off never speaks
  const synth = getSynth();
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") return;
  try {
    const primer = new SpeechSynthesisUtterance(" ");
    primer.volume = 0.01; // inaudible, but nonzero gain for the session
    const resetSession = () => {
      if (speakingNow) return; // a live reply owns the session now
      try {
        synth.cancel();
      } catch {
        // some engines throw on cancel with nothing queued
      }
    };
    primer.onend = resetSession;
    primer.onerror = resetSession;
    synth.speak(primer);
    speechUnlocked = true;
  } catch {
    // stay locked; the next tap tries again
  }
}
