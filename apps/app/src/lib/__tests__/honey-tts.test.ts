import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  HONEY_TTS_MODE_CHANGED_EVENT,
  HONEY_TTS_MODE_KEY,
  SPEECH_CAP_CHARS,
  SPEECH_CHUNK_CHARS,
  cancelSpeech,
  capForSpeech,
  chunkForSpeech,
  cleanForSpeech,
  getTtsMode,
  maybeAutoSpeak,
  pickVoice,
  setTtsMode,
  shouldAutoSpeak,
  speakReply,
  subscribeSpeaking,
  subscribeTtsErrors,
  unlockSpeech,
  type TtsError,
} from "@/lib/honey-tts";

// Honey TTS (kanban/device-input-matrix slice 3, iPhone voice
// contract): mode logic, markdown stripping, the ~700-char cap, the
// ≤200-char sentence chunking iOS needs, and the speech controller's
// guarantees (off never speaks, new speech replaces old, cancel stops
// and reports idle). The iOS gesture primer speaks at 0.01 gain — a
// volume-0 primer pins the audio session at zero gain and later
// utterances play SILENT — and cancels itself once done; real
// utterances always set volume = 1 explicitly. The voice picker pins
// an explicit en/local/known-good voice (the iOS system default can
// fail silently — speaking=true, no audio, owner phone 2026-10-20)
// and never blocks speech while the list is loading; utterance errors
// reach subscribers so no failure is silent again.

class FakeUtterance {
  text: string;
  // tripwire default: a queued utterance that never set its volume
  // explicitly fails the volume assertions below
  volume = 0;
  // null = never assigned — the system-default voice path
  voice: SpeechSynthesisVoice | null = null;
  onend: (() => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

function installFakeSynth() {
  const spoken: FakeUtterance[] = [];
  let cancelled = 0;
  const synth = {
    speak: (u: FakeUtterance) => spoken.push(u),
    cancel: () => {
      cancelled += 1;
    },
    speaking: false,
  };
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  return {
    spoken,
    isCancelled: () => cancelled,
    texts: () => spoken.map((u) => u.text),
  };
}

// A voice-list synth: getVoices() answers live, voiceschanged has
// real listeners — everything the picker needs to be exercised.
function fakeVoice(
  name: string,
  lang = "en-US",
  localService = true,
): SpeechSynthesisVoice {
  return { name, lang, localService, default: false, voiceURI: name };
}

function installSynthWithVoices(voices: SpeechSynthesisVoice[]) {
  const spoken: FakeUtterance[] = [];
  let cancelled = 0;
  let current = voices;
  const listeners = new Set<() => void>();
  const synth = {
    speak: (u: FakeUtterance) => spoken.push(u),
    cancel: () => {
      cancelled += 1;
    },
    speaking: false,
    getVoices: () => current,
    addEventListener: (_type: string, fn: () => void) => {
      listeners.add(fn);
    },
    removeEventListener: (_type: string, fn: () => void) => {
      listeners.delete(fn);
    },
  };
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  return {
    spoken,
    isCancelled: () => cancelled,
    setVoices: (next: SpeechSynthesisVoice[]) => {
      current = next;
    },
    fireVoicesChanged: () => {
      for (const fn of listeners) fn();
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- mode storage ---

it("defaults to auto when the key is unset", () => {
  expect(getTtsMode()).toBe("auto");
});

it("a corrupt stored mode is ignored, not trusted", () => {
  window.localStorage.setItem(HONEY_TTS_MODE_KEY, "yelling");
  expect(getTtsMode()).toBe("auto");
});

it("setTtsMode round-trips and fires the changed event", () => {
  const heard: string[] = [];
  const onEvent = () => heard.push(getTtsMode());
  window.addEventListener(HONEY_TTS_MODE_CHANGED_EVENT, onEvent);
  setTtsMode("manual");
  expect(window.localStorage.getItem(HONEY_TTS_MODE_KEY)).toBe("manual");
  expect(getTtsMode()).toBe("manual");
  expect(heard).toEqual(["manual"]);
  window.removeEventListener(HONEY_TTS_MODE_CHANGED_EVENT, onEvent);
});

// --- mode × device matrix ---

it("auto mode speaks only phone-tagged runs", () => {
  expect(shouldAutoSpeak("auto", "phone")).toBe(true);
  expect(shouldAutoSpeak("auto", "ipad")).toBe(false);
  expect(shouldAutoSpeak("auto", "laptop")).toBe(false);
  expect(shouldAutoSpeak("auto", "studio")).toBe(false);
});

it("manual and off never auto-speak, on any device", () => {
  for (const mode of ["manual", "off"] as const) {
    for (const device of ["phone", "ipad", "laptop", "studio"] as const) {
      expect(shouldAutoSpeak(mode, device)).toBe(false);
    }
  }
});

it("maybeAutoSpeak speaks only the auto+phone corner", () => {
  const { texts } = installFakeSynth();
  maybeAutoSpeak("Hello from the phone lane.", "studio");
  expect(texts()).toEqual([]);
  maybeAutoSpeak("Hello from the phone lane.", "phone");
  expect(texts()).toEqual(["Hello from the phone lane."]);
});

// --- markdown stripping ---

it("strips fenced code blocks entirely and unwraps inline code", () => {
  expect(
    cleanForSpeech("Before\n```js\nconst x = 1;\n```\nAfter"),
  ).toBe("Before After");
  expect(cleanForSpeech("Run `pnpm test` now")).toBe("Run pnpm test now");
});

it("speaks link text, not URLs; images speak their alt text", () => {
  expect(cleanForSpeech("See [the map](http://x/y) now")).toBe("See the map now");
  expect(cleanForSpeech("![a diagram](http://x.png)")).toBe("a diagram");
});

it("unwraps headings, list markers, quotes and emphasis", () => {
  expect(
    cleanForSpeech("# Title\n- item one\n1. step two\n> quoted\n**bold** and _ital_"),
  ).toBe("Title item one step two quoted bold and ital");
});

it("leaves snake_case identifiers intact", () => {
  expect(cleanForSpeech("the device_input_matrix file")).toBe(
    "the device_input_matrix file",
  );
});

it("collapses tables and stray HTML to plain text", () => {
  expect(cleanForSpeech("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a b 1 2");
  expect(cleanForSpeech("hi <br/> there")).toBe("hi there");
});

// --- the ~700-char cap ---

it("short replies pass through untouched", () => {
  expect(capForSpeech("Short reply.")).toBe("Short reply.");
});

it("caps at a sentence end near the limit and announces the tail", () => {
  const sentences: string[] = [];
  for (let i = 0; i < 40; i++) sentences.push(`Sentence number ${i} says something.`);
  const capped = capForSpeech(sentences.join(" "));
  expect(capped.length).toBeLessThanOrEqual(
    SPEECH_CAP_CHARS + " Message continues on screen.".length,
  );
  expect(capped.endsWith(" Message continues on screen.")).toBe(true);
  // the cut happened at a sentence boundary, not mid-word
  expect(capped).toMatch(/says something\. Message continues on screen\.$/);
});

// --- iOS-safe chunking ---

it("packs sentences into chunks of at most 200 chars", () => {
  const text = Array.from({ length: 30 }, (_, i) => `Line ${i} of the reply.`).join(" ");
  const chunks = chunkForSpeech(text);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(SPEECH_CHUNK_CHARS);
  expect(chunks.join(" ")).toBe(text);
});

it("hard-splits an oversized sentence at word boundaries", () => {
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" "); // ~420 chars, one "sentence"
  const chunks = chunkForSpeech(words);
  expect(chunks.length).toBeGreaterThanOrEqual(3);
  for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(SPEECH_CHUNK_CHARS);
  expect(chunks.join(" ")).toBe(words);
});

it("returns nothing for empty text", () => {
  expect(chunkForSpeech("   ")).toEqual([]);
});

// --- the speech controller ---

it("off mode never speaks, even when asked directly", () => {
  const { texts } = installFakeSynth();
  setTtsMode("off");
  speakReply("Hello there.");
  expect(texts()).toEqual([]);
});

it("queues the cleaned, capped, chunked reply as short utterances", () => {
  const { texts, spoken } = installFakeSynth();
  speakReply("## Header\nFirst sentence here. ```\ncode()\n``` Second one with a [link](http://x).");
  expect(texts().join(" ")).toBe("Header First sentence here. Second one with a link.");
  for (const u of spoken) expect(u.text.length).toBeLessThanOrEqual(SPEECH_CHUNK_CHARS);
});

it("reports speaking state, then idle when the last chunk ends", () => {
  const { spoken } = installFakeSynth();
  const states: boolean[] = [];
  const unsubscribe = subscribeSpeaking((active) => states.push(active));
  speakReply("One. Two. Three.");
  expect(states.at(-1)).toBe(true);
  spoken.at(-1)!.onend?.();
  expect(states.at(-1)).toBe(false);
  unsubscribe();
});

it("new speech replaces old and cancel stops immediately", () => {
  const { texts, isCancelled } = installFakeSynth();
  speakReply("First reply.");
  speakReply("Second reply.");
  expect(isCancelled()).toBeGreaterThanOrEqual(1); // old voice never lingers
  expect(texts().at(-1)).toBe("Second reply.");
  const states: boolean[] = [];
  const unsubscribe = subscribeSpeaking((active) => states.push(active));
  cancelSpeech();
  expect(isCancelled()).toBeGreaterThanOrEqual(2);
  expect(states.at(-1)).toBe(false);
  unsubscribe();
});

it("an error mid-reply aborts the whole playback", () => {
  const { spoken } = installFakeSynth();
  const states: boolean[] = [];
  const unsubscribe = subscribeSpeaking((active) => states.push(active));
  // three sentences long enough that packing cannot merge them (each >100 chars)
  const filler = "with a long run of ordinary speaking words that keep going and going well past the hundred-character mark";
  const long = [`One ${filler}.`, `Two ${filler}.`, `Three ${filler}.`].join(" ");
  speakReply(long);
  expect(spoken.length).toBe(3); // one chunk per sentence
  spoken[0]!.onerror?.(); // a middle chunk fails → the rest is cancelled
  expect(states.at(-1)).toBe(false);
  unsubscribe();
});

it("a reply over the cap still speaks only the capped head", () => {
  const { texts } = installFakeSynth();
  const long = Array.from({ length: 40 }, (_, i) => `Sentence ${i} goes here.`).join(" ");
  speakReply(long);
  expect(texts().join(" ")).toContain("Message continues on screen.");
});

// --- the iOS gesture unlock ---

// One test owns the whole primer lifecycle: speechUnlocked is module
// state, so a second test could never prime again.
it("primes once at 0.01 gain, resets the session after, never in off mode, never cuts a live reply", () => {
  const { spoken, isCancelled } = installFakeSynth();
  setTtsMode("off");
  unlockSpeech(); // off mode never speaks, not even the primer
  expect(spoken.length).toBe(0);
  setTtsMode("auto");
  unlockSpeech(); // first allowed tap primes
  unlockSpeech(); // later taps: no-op
  expect(spoken.length).toBe(1);
  expect(spoken[0]!.volume).toBe(0.01); // nonzero gain — 0 pins iOS at silence
  expect(isCancelled()).toBe(0); // not cancelled while the primer is in flight
  // a reply that queues while the primer is still finishing owns the
  // session — the primer's trailing cancel must not cut into it
  const states: boolean[] = [];
  const unsubscribe = subscribeSpeaking((active) => states.push(active));
  speakReply("A reply racing the primer.");
  const afterReplyStart = isCancelled(); // the reply's own start-cancel
  spoken[0]!.onend?.(); // primer completes AFTER the reply queued
  expect(isCancelled()).toBe(afterReplyStart); // its session reset is suppressed
  expect(states.at(-1)).toBe(true); // the reply is still speaking
  unsubscribe();
  cancelSpeech(); // release the reply — primer is spent either way
  spoken[0]!.onend?.(); // primer end with nothing live → resets the session
  expect(isCancelled()).toBe(afterReplyStart + 2); // reply cancel + primer reset
  spoken[0]!.onerror?.(); // an errored primer resets too, and never throws
  expect(isCancelled()).toBe(afterReplyStart + 3);
});

it("real utterances always carry explicit full volume, never inherited gain", () => {
  const { spoken } = installFakeSynth();
  speakReply("One sentence here. Another one follows it.");
  expect(spoken.length).toBeGreaterThan(0);
  for (const u of spoken) expect(u.volume).toBe(1);
});

// --- the explicit voice picker (quirk 4: the iOS system default can
// fail silently — speaking=true, no audio, owner phone 2026-10-20) ---

it("pickVoice prefers en, on-device, and the known-good iOS names in order", () => {
  const fr = fakeVoice("Thomas", "fr-FR");
  const zoe = fakeVoice("Zoey", "en-US", true);
  // a known-good name beats an earlier-listed stranger
  expect(pickVoice([fr, zoe, fakeVoice("Nick", "en-US", true)])?.name).toBe("Nick");
  // the name order itself: Ava ranks above Nick
  expect(pickVoice([zoe, fakeVoice("Nick"), fakeVoice("Ava")])?.name).toBe("Ava");
  // on-device beats a remote voice, even a remote known-good name
  expect(pickVoice([fakeVoice("Samantha", "en-US", false), zoe])?.name).toBe("Zoey");
  // the language match wins over list position
  expect(pickVoice([fr, zoe])?.name).toBe("Zoey");
  // no en voice at all → any voice beats none
  expect(pickVoice([fr, fakeVoice("Google français", "fr-FR", false)])?.name).toBe("Thomas");
  // nothing loaded → null → utterance.voice stays unset (system default)
  expect(pickVoice([])).toBeNull();
});

it("waits out the async voice list: picks once voiceschanged delivers, never blocks before", () => {
  const env = installSynthWithVoices([]);
  speakReply("First try."); // voices not loaded yet — the usual iOS first call
  expect(env.spoken).toHaveLength(1); // speech queued anyway — never blocked
  expect(env.spoken[0]!.voice).toBeNull(); // system default, deliberately
  env.setVoices([fakeVoice("Zoey"), fakeVoice("Samantha")]);
  env.fireVoicesChanged(); // the list arrives late
  speakReply("Second try.");
  expect(env.spoken.at(-1)!.voice?.name).toBe("Samantha"); // the pick, cached
});

it("re-picks through the timeout backstop when voiceschanged never fires", () => {
  vi.useFakeTimers();
  try {
    const env = installSynthWithVoices([]);
    speakReply("Nothing loaded.");
    expect(env.spoken[0]!.voice).toBeNull();
    env.setVoices([fakeVoice("Samantha")]);
    vi.advanceTimersByTime(1500); // VOICES_WAIT_MS, without the event
    speakReply("After the wait.");
    expect(env.spoken.at(-1)!.voice?.name).toBe("Samantha");
  } finally {
    vi.useRealTimers();
  }
});

it("still speaks with the system default when no voice ever loads", () => {
  vi.useFakeTimers();
  try {
    const env = installSynthWithVoices([]);
    speakReply("No voices anywhere.");
    vi.advanceTimersByTime(1500); // the backstop ran and found nothing
    speakReply("Trying again regardless.");
    expect(env.spoken).toHaveLength(2); // never blocked on the picker
    for (const u of env.spoken) expect(u.voice).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

// --- voice errors, surfaced (no silent failures) ---

it("utterance errors reach subscribers with the payload; deliberate cancels stay silent", () => {
  const { spoken } = installFakeSynth();
  const heard: TtsError[] = [];
  const unsubscribe = subscribeTtsErrors((e) => heard.push(e));
  speakReply("One sentence only.");
  spoken[0]!.onerror?.({ error: "synthesis-failed" });
  expect(heard).toEqual([{ type: "synthesis-failed", message: "" }]);
  spoken[0]!.onerror?.({ error: "canceled" }); // our own stop chip
  spoken[0]!.onerror?.({ error: "interrupted" }); // a new run's reset
  expect(heard).toHaveLength(1); // neither is a failure
  spoken[0]!.onerror?.(); // no event object at all — still reported
  expect(heard.at(-1)).toEqual({ type: "unknown", message: "" });
  unsubscribe();
  spoken[0]!.onerror?.({ error: "voice-unavailable" });
  expect(heard).toHaveLength(2); // unsubscribed: nothing more arrives
});

it("a failed mid-reply chunk reports the error AND aborts playback", () => {
  const env = installSynthWithVoices([]);
  const heard: TtsError[] = [];
  const unsubscribe = subscribeTtsErrors((e) => heard.push(e));
  const filler = "with a long run of ordinary speaking words that keep going and going well past the hundred-character mark";
  const long = [`One ${filler}.`, `Two ${filler}.`, `Three ${filler}.`].join(" ");
  speakReply(long);
  expect(env.spoken.length).toBe(3);
  const before = env.isCancelled();
  env.spoken[0]!.onerror?.({ error: "voice-unavailable", message: "no such voice" });
  expect(env.isCancelled()).toBe(before + 1); // the rest of the reply died
  expect(heard).toEqual([{ type: "voice-unavailable", message: "no such voice" }]);
  unsubscribe();
});
