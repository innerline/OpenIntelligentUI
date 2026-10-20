import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  HONEY_TTS_MODE_KEY,
  cancelSpeech,
  cleanForSpeech,
  getTtsMode,
  getVoiceNote,
  isSpeaking,
  maybeAutoVoiceNote,
  playVoiceNote,
  primeVoiceAudio,
  requestVoiceNote,
  resetVoiceLaneForTests,
  setTtsMode,
  shouldAutoSpeak,
  subscribeSpeaking,
  subscribeTtsErrors,
  subscribeVoiceNote,
  type TtsError,
  type TtsMode,
} from "@/lib/honey-tts";

// Server-rendered voice notes (kanban/device-input-matrix, iPhone
// voice contract). The Web Speech lane is GONE — four builds stayed
// silent on the owner's phone; this suite pins its replacement: the
// render request, the per-message chip state, the shared Audio
// element's primer/play/stop lifecycle, and the mode × device matrix.

class FakeAudio {
  static instances: FakeAudio[] = [];
  src = "";
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });
  preload = "";
  constructor() {
    FakeAudio.instances.push(this);
  }
}

let renderHandler: ((body: { text: string; sessionHint?: string }) => Response) | null =
  null;

beforeEach(() => {
  window.localStorage.clear();
  resetVoiceLaneForTests();
  FakeAudio.instances = [];
  renderHandler = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/cockpit/voice/render") {
        if (!renderHandler) throw new Error("no render handler installed");
        return renderHandler(JSON.parse(String(init?.body ?? "{}")));
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    }),
  );
  vi.stubGlobal("Audio", FakeAudio);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okRender(url = "/api/cockpit/voice/audio?id=abc.m4a"): Response {
  return Response.json({ url, cached: false });
}

// --- modes (localStorage lane, corrupt values never trusted) ---

it("defaults to auto and persists a set mode", () => {
  expect(getTtsMode()).toBe<TtsMode>("auto");
  setTtsMode("manual");
  expect(getTtsMode()).toBe<TtsMode>("manual");
  expect(window.localStorage.getItem(HONEY_TTS_MODE_KEY)).toBe("manual");
});

it("a corrupt pin is ignored, not trusted", () => {
  window.localStorage.setItem(HONEY_TTS_MODE_KEY, "yell");
  expect(getTtsMode()).toBe<TtsMode>("auto");
});

it("auto mode voices ONLY phone-tagged runs", () => {
  expect(shouldAutoSpeak("auto", "phone")).toBe(true);
  expect(shouldAutoSpeak("auto", "studio")).toBe(false);
  expect(shouldAutoSpeak("auto", "laptop")).toBe(false);
  expect(shouldAutoSpeak("auto", "ipad")).toBe(false);
  expect(shouldAutoSpeak("manual", "phone")).toBe(false);
  expect(shouldAutoSpeak("off", "phone")).toBe(false);
});

// --- cleaning (the text handed to the server renderer) ---

it("cleanForSpeech strips markdown, keeps words", () => {
  expect(
    cleanForSpeech("# Heading\n\n- **bold** item\n\n[link](https://x.y) tail"),
  ).toBe("Heading bold item link tail");
});

it("cleanForSpeech drops fenced code entirely", () => {
  expect(cleanForSpeech("before\n```py\nprint(1)\n```\nafter")).toBe(
    "before after",
  );
});

// --- render requests ---

it("requestVoiceNote posts the cleaned text and lands a ready chip", async () => {
  renderHandler = (body) => {
    expect(body.text).toBe("Speak this.");
    expect(typeof body.sessionHint).toBe("string");
    return okRender("/api/cockpit/voice/audio?id=deadbeef.m4a");
  };
  const states: string[] = [];
  subscribeVoiceNote("m1", (s) => states.push(s.status));
  const final = await requestVoiceNote("m1", "Speak **this**.");
  expect(final.status).toBe("ready");
  expect(getVoiceNote("m1")).toMatchObject({
    status: "ready",
    url: "/api/cockpit/voice/audio?id=deadbeef.m4a",
  });
  expect(states).toEqual(["rendering", "ready"]);
});

it("a render failure is NEVER silent: chip state + the error lane", async () => {
  renderHandler = () => new Response("boom", { status: 500 });
  const errors: TtsError[] = [];
  subscribeTtsErrors((e) => errors.push(e));
  const final = await requestVoiceNote("m2", "This render will fail.");
  expect(final.status).toBe("failed");
  expect(getVoiceNote("m2")?.status).toBe("failed");
  expect(errors).toHaveLength(1);
  expect(errors[0]?.type).toBe("voice-render-failed");
  expect(errors[0]?.message).toContain("500");
});

it("a failed chip can be asked again; a ready one is not re-requested", async () => {
  let calls = 0;
  renderHandler = () => {
    calls += 1;
    return calls === 1
      ? new Response("down", { status: 500 })
      : okRender("/u.m4a");
  };
  await requestVoiceNote("m3", "First try.");
  const second = await requestVoiceNote("m3", "First try.");
  expect(second.status).toBe("ready"); // retried after failure
  const third = await requestVoiceNote("m3", "First try.");
  expect(third.status).toBe("ready");
  expect(calls).toBe(2); // ready short-circuits, no third request
});

// --- the phone auto lane ---

it("maybeAutoVoiceNote renders + plays on the auto/phone corner", async () => {
  renderHandler = () => okRender("/api/cockpit/voice/audio?id=auto.m4a");
  maybeAutoVoiceNote("Phone reply.", "phone", "run-1");
  await vi.waitFor(() => {
    expect(FakeAudio.instances).toHaveLength(1);
  });
  const el = FakeAudio.instances[0]!;
  await vi.waitFor(() => {
    expect(el.src).toBe("/api/cockpit/voice/audio?id=auto.m4a");
  });
  expect(el.play).toHaveBeenCalled();
  expect(getVoiceNote("run-1")?.status).toBe("ready");
});

it("maybeAutoVoiceNote stays silent off the corner", async () => {
  renderHandler = () => okRender();
  maybeAutoVoiceNote("Studio reply.", "studio", "run-2");
  setTtsMode("off");
  maybeAutoVoiceNote("Off reply.", "phone", "run-3");
  setTtsMode("manual");
  maybeAutoVoiceNote("Manual reply.", "phone", "run-4");
  await new Promise((r) => setTimeout(r, 10));
  expect(FakeAudio.instances).toHaveLength(0);
  expect(getVoiceNote("run-2")).toBeNull();
  expect(getVoiceNote("run-3")).toBeNull();
  expect(getVoiceNote("run-4")).toBeNull();
});

// --- playback lifecycle ---

it("playing sets the speaking state; ended clears it", async () => {
  renderHandler = () => okRender("/p.m4a");
  maybeAutoVoiceNote("Speaking reply.", "phone", "run-5");
  await vi.waitFor(() => expect(isSpeaking()).toBe(true));
  const el = FakeAudio.instances[0]!;
  el.onended?.();
  expect(isSpeaking()).toBe(false);
});

it("an autoplay rejection is swallowed (the chip answers), an element error is not", async () => {
  renderHandler = () => okRender("/blocked.m4a");
  const el0 = FakeAudio.instances[0];
  expect(el0).toBeUndefined();
  maybeAutoVoiceNote("Blocked reply.", "phone", "run-6");
  await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
  const el = FakeAudio.instances[0]!;
  (el.play as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
    new Error("autoplay blocked"),
  );
  const errors: TtsError[] = [];
  subscribeTtsErrors((e) => errors.push(e));
  playVoiceNote("/blocked2.m4a");
  await vi.waitFor(() => expect(isSpeaking()).toBe(false)); // rejected → silent
  expect(errors).toHaveLength(0); // blocked autoplay is not an error
  el.onerror?.();
  expect(errors).toHaveLength(1); // decode/network IS reported
  expect(errors[0]?.type).toBe("voice-playback-failed");
});

it("cancelSpeech stops the element and clears speaking", async () => {
  renderHandler = () => okRender("/c.m4a");
  maybeAutoVoiceNote("Cancel me.", "phone", "run-7");
  await vi.waitFor(() => expect(isSpeaking()).toBe(true));
  const speakingUpdates: boolean[] = [];
  subscribeSpeaking((a) => speakingUpdates.push(a));
  cancelSpeech();
  const el = FakeAudio.instances[0]!;
  expect(el.pause).toHaveBeenCalled();
  expect(isSpeaking()).toBe(false);
  expect(speakingUpdates.at(-1)).toBe(false);
});

it("off mode never plays, even with a ready note", async () => {
  setTtsMode("off");
  playVoiceNote("/never.m4a");
  expect(FakeAudio.instances).toHaveLength(0);
});

// --- the iOS gesture primer ---

it("primeVoiceAudio primes once with the shared element; off never primes", async () => {
  primeVoiceAudio();
  primeVoiceAudio(); // second tap: no-op
  expect(FakeAudio.instances).toHaveLength(1);
  const el = FakeAudio.instances[0]!;
  expect(el.play).toHaveBeenCalledTimes(1);
  expect(el.src).toMatch(/^data:audio\/wav;base64,/); // digital silence
  resetVoiceLaneForTests();
  FakeAudio.instances = [];
  setTtsMode("off");
  primeVoiceAudio();
  expect(FakeAudio.instances).toHaveLength(0); // off never primes
});

it("the primer's data URI is a real 50ms silent WAV", () => {
  primeVoiceAudio();
  const el = FakeAudio.instances[0]!;
  const b64 = el.src.split(",")[1] ?? "";
  const bin = atob(b64);
  expect(bin.length).toBe(444); // 44-byte header + 400 samples
  expect(bin.slice(0, 4)).toBe("RIFF");
  expect(bin.slice(8, 12)).toBe("WAVE");
  // every sample is digital silence at the 8-bit midpoint (128)
  for (let i = 44; i < bin.length; i++) {
    expect(bin.charCodeAt(i)).toBe(128);
  }
});

it("playback reuses the primed element (iOS unlock survives src swaps)", async () => {
  primeVoiceAudio();
  renderHandler = () => okRender("/swap.m4a");
  maybeAutoVoiceNote("Same element.", "phone", "run-8");
  await vi.waitFor(() => expect(FakeAudio.instances[0]?.src).toBe("/swap.m4a"));
  expect(FakeAudio.instances).toHaveLength(1); // no second element
});
