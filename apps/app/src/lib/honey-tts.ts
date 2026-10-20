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
  let queued = false;
  chunks.forEach((chunk, i) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.volume = 1; // explicit — never inherit the primer's 0.01
    if (i === chunks.length - 1) {
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
    } else {
      // a failed mid-reply chunk aborts the whole playback cleanly
      utterance.onerror = () => cancelSpeech();
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
