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
  setTtsMode,
  shouldAutoSpeak,
  speakReply,
  subscribeSpeaking,
  unlockSpeech,
} from "@/lib/honey-tts";

// Honey TTS (kanban/device-input-matrix slice 3, iPhone voice
// contract): mode logic, markdown stripping, the ~700-char cap, the
// ≤200-char sentence chunking iOS needs, and the speech controller's
// guarantees (off never speaks, new speech replaces old, cancel stops
// and reports idle).

class FakeUtterance {
  text: string;
  volume = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
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

it("unlockSpeech primes once with an inaudible utterance, and never in off mode", () => {
  const { spoken } = installFakeSynth();
  setTtsMode("off");
  unlockSpeech(); // off mode never speaks, not even the primer
  expect(spoken.length).toBe(0);
  setTtsMode("auto");
  unlockSpeech(); // first allowed tap primes
  unlockSpeech(); // later taps: no-op
  expect(spoken.length).toBe(1);
  expect(spoken[0]!.volume).toBe(0);
});
