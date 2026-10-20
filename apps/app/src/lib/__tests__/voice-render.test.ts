import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Server-rendered voice notes — the render lib + both routes. The
// process surface (child_process, fs on the voice dir) is mocked or
// pointed at a scratch dir; nothing here touches the real runtime/.

const STUDIO_LISTING =
  "Albert              en_US    # Hello! My name is Albert.\n" +
  'Samantha (English (US)) en_US    # Hello! My name is Samantha.\n';

const hoisted = vi.hoisted(() => ({
  listing: "",
  sayCalls: [] as { file: string; args: string[] }[],
  failRenders: false,
  failPiper: false,
  failAfconvert: false,
}));

vi.mock("child_process", () => {
  const execFileMock = (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout?: string, stderr?: string) => void,
  ) => {
    hoisted.sayCalls.push({ file, args });
    if (hoisted.failRenders) {
      cb(new Error("say exploded"));
      return;
    }
    if (path.basename(file) === "piper") {
      if (hoisted.failPiper) {
        cb(new Error("piper exploded"));
        return;
      }
      // `piper` would write the wav at -f — do exactly that
      const out = args[args.indexOf("-f") + 1] as string;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from("fake-piper-wav"));
      cb(null, "", "");
      return;
    }
    if (path.basename(file) === "afconvert") {
      if (hoisted.failAfconvert) {
        cb(new Error("afconvert exploded"));
        return;
      }
      // afconvert's LAST argument is the output file
      fs.writeFileSync(args[args.length - 1] as string, Buffer.from("fake-aac-bytes"));
      cb(null, "", "");
      return;
    }
    if (file !== "say") {
      cb(new Error(`unexpected binary: ${file}`));
      return;
    }
    if (args[0] === "-v" && args[1] === "?") {
      cb(null, hoisted.listing, "");
      return;
    }
    // a render: `say` would write the output file — do exactly that
    const out = args[args.indexOf("-o") + 1] as string;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from("fake-aac-bytes"));
    cb(null, "", "");
  };
  return { execFile: execFileMock, default: { execFile: execFileMock } };
});

import {
  PREFERRED_SAY_VOICES,
  VOICE_TEXT_CAP_CHARS,
  capVoiceText,
  parseSayVoices,
  pickSayVoice,
  piperAvailable,
  piperOverride,
  pruneVoiceFiles,
  resetVoiceRenderCaches,
  sanitizeVoiceText,
  voiceFileHash,
  voiceSpeedScale,
  type SayVoice,
  type VoiceDeps,
} from "@/lib/voice-render";
import { POST as renderPOST } from "@/app/api/cockpit/voice/render/route";
import { GET as audioGET } from "@/app/api/cockpit/voice/audio/route";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "voice-notes-test-"));
const voiceDir = path.join(scratch, "voice");
const piperDir = path.join(scratch, "piper");
const piperBinPath = path.join(scratch, "bin", "piper");

// Install a fake piper (bin + model files) under the scratch dir and
// point the env seams at it — route tests use the REAL fs surface.
function installFakePiper(model = "en_US-amy-medium"): void {
  process.env.MWP_PIPER_BIN = piperBinPath;
  process.env.MWP_PIPER_DIR = piperDir;
  fs.mkdirSync(path.dirname(piperBinPath), { recursive: true });
  fs.writeFileSync(piperBinPath, "#!/bin/sh\n");
  fs.mkdirSync(piperDir, { recursive: true });
  fs.writeFileSync(path.join(piperDir, `${model}.onnx`), "fake-onnx");
  fs.writeFileSync(path.join(piperDir, `${model}.onnx.json`), "{}");
}

beforeEach(() => {
  process.env.MWP_VOICE_DIR = voiceDir;
  // pin the override — the machine's real runtime/voice-override.txt
  // (live owner config, may say "piper:…" with a speed line) must not
  // steer say tests
  process.env.MWP_VOICE_OVERRIDE = "";
  delete process.env.HONEY_VOICE_SPEED; // speed knob starts neutral too
  hoisted.listing = STUDIO_LISTING; // reset per test — no leak
  hoisted.sayCalls.length = 0;
  hoisted.failRenders = false;
  hoisted.failPiper = false;
  hoisted.failAfconvert = false;
  resetVoiceRenderCaches();
  fs.rmSync(voiceDir, { recursive: true, force: true });
  // no piper install leaks between tests — tests that need one call
  // installFakePiper() themselves
  fs.rmSync(piperDir, { recursive: true, force: true });
  fs.rmSync(path.dirname(piperBinPath), { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.MWP_VOICE_DIR;
  delete process.env.MWP_VOICE_OVERRIDE;
  delete process.env.MWP_PIPER_BIN;
  delete process.env.MWP_PIPER_DIR;
  delete process.env.HONEY_VOICE_SPEED;
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function post(body: unknown): Promise<Response> {
  return renderPOST(
    new Request("http://x/api/cockpit/voice/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function get(id: string, range?: string): Promise<Response> {
  return audioGET(
    new Request(`http://x/api/cockpit/voice/audio?id=${encodeURIComponent(id)}`, {
      headers: range ? { range } : {},
    }),
  );
}

function renderCalls() {
  return hoisted.sayCalls.filter((c) => c.file === "say" && c.args[0] !== "-v");
}

function piperCalls() {
  return hoisted.sayCalls.filter((c) => path.basename(c.file) === "piper");
}

function sayRenderCalls() {
  return hoisted.sayCalls.filter(
    (c) => c.file === "say" && c.args[0] !== "-v",
  );
}

// --- pure pieces ---

it("parses the real `say -v ?` shape (parenthesized names, junk lines)", () => {
  const voices = parseSayVoices(
    [
      "Albert              en_US    # Hello! My name is Albert.",
      "Samantha (English (US)) en_US    # Hello! My name is Samantha.",
      "Daniel              en_GB    # Hello! My name is Daniel.",
      "not a voice line at all",
      "",
    ].join("\n"),
  );
  expect(voices).toEqual([
    { name: "Albert", locale: "en_US" },
    { name: "Samantha (English (US))", locale: "en_US" },
    { name: "Daniel", locale: "en_GB" },
  ]);
});

it("prefers premium voices first, plain names match locale-decorated listings", () => {
  const mk = (rows: string): SayVoice[] => parseSayVoices(rows);
  expect(PREFERRED_SAY_VOICES).toEqual([
    "Ava (Premium)",
    "Samantha (Premium)",
    "Ava",
    "Samantha",
  ]);
  // Ava (Premium) wins over everything
  expect(
    pickSayVoice(
      mk(
        "Samantha (English (US)) en_US # x\nAva (Premium) en_US # x\nAva en_US # x\n",
      ),
    ),
  ).toBe("Ava (Premium)");
  // plain "Ava" beats plain Samantha, but NOT Samantha (Premium) —
  // the design's preference order puts both premiums first
  expect(
    pickSayVoice(mk("Samantha (Premium) en_US # x\nAva (English (US)) en_US # x\n")),
  ).toBe("Samantha (Premium)");
  expect(pickSayVoice(mk("Samantha (English (US)) en_US # x\nAva en_US # x\n"))).toBe(
    "Ava",
  );
  // this Studio's actual shape: only decorated Samantha exists
  expect(pickSayVoice(mk("Samantha (English (US)) en_US # x\nAlbert en_US # x\n"))).toBe(
    "Samantha (English (US))",
  );
  // premium and plain are DIFFERENT keys: a plain-only listing must
  // not satisfy the premium preference
  expect(
    pickSayVoice(mk("Samantha (English (US)) en_US # x\n")) ===
      "Samantha (Premium)",
  ).toBe(false);
  // non-English voices never qualify; no match → system default (null)
  expect(pickSayVoice(mk("Daniel en_GB # x\n"))).toBe(null);
  expect(pickSayVoice(mk("Albert en_US # x\n"))).toBe(null);
  expect(pickSayVoice(mk(""))).toBe(null);
});

it("sanitize strips control characters and collapses whitespace", () => {
  expect(sanitizeVoiceText("a\u0000b\u0007c\u0085d\u2028e")).toBe("a b c d e");
  expect(sanitizeVoiceText("  lots    of \n\n space\ttabs  ")).toBe(
    "lots of space tabs",
  );
});

it("cap keeps short text whole, cuts long text at a sentence with the tail", () => {
  expect(capVoiceText("short")).toBe("short");
  const long = `${"word ".repeat(600)}. End of the long reply.`;
  const capped = capVoiceText(long);
  expect(capped.length).toBeLessThanOrEqual(VOICE_TEXT_CAP_CHARS + 40);
  expect(capped.endsWith("Message continues on screen.")).toBe(true);
  expect(capped).toContain("."); // cut on a sentence, not mid-word
});

it("the hash is deterministic and sensitive to voice, text, and speed", () => {
  const a = voiceFileHash("hello", "Samantha (English (US))", 1);
  expect(a).toBe(voiceFileHash("hello", "Samantha (English (US))", 1));
  expect(a).not.toBe(voiceFileHash("hello", null, 1));
  expect(a).not.toBe(voiceFileHash("hello!", "Samantha (English (US))", 1));
  // 1x and 1.5x renders of the same text NEVER share a file — the
  // speed scale is part of the cache identity
  expect(a).not.toBe(voiceFileHash("hello", "Samantha (English (US))", 0.67));
  expect(voiceFileHash("hello", null, 0.67)).not.toBe(
    voiceFileHash("hello", null, 1.5),
  );
  expect(a).toMatch(/^[a-f0-9]{64}$/);
});

// --- render orchestration (injected deps) ---

type FakeVoiceDeps = VoiceDeps & {
  execCalls: { file: string; args: string[] }[];
};

function fakeDeps(files: Record<string, string> = {}): FakeVoiceDeps {
  const execCalls: { file: string; args: string[] }[] = [];
  const exec = vi.fn(async (file: string, args: string[]) => {
    execCalls.push({ file, args });
    if (path.basename(file) === "piper") {
      files[path.basename(args[args.indexOf("-f") + 1] as string)] = "rendered";
      return { stdout: "", stderr: "" };
    }
    if (path.basename(file) === "afconvert") {
      files[path.basename(args[args.length - 1] as string)] = "rendered";
      return { stdout: "", stderr: "" };
    }
    expect(file).toBe("say");
    if (args[0] === "-v" && args[1] === "?") {
      return { stdout: hoisted.listing || STUDIO_LISTING, stderr: "" };
    }
    files[path.basename(args[args.indexOf("-o") + 1] as string)] = "rendered";
    return { stdout: "", stderr: "" };
  });
  return {
    exec,
    execCalls,
    exists: (p: string) =>
      Object.prototype.hasOwnProperty.call(files, path.basename(p)),
    stat: (p: string) => ({
      mtimeMs: files[path.basename(p)] === "old" ? 0 : Date.now(),
    }),
    readdir: () => Object.keys(files),
    unlink: (p: string) => {
      delete files[path.basename(p)];
    },
    mkdir: () => {},
    writeFile: (p: string, data: string) => {
      files[path.basename(p)] = data;
    },
  };
}

it("renders with the full say argument shape", async () => {
  const deps = fakeDeps();
  hoisted.listing =
    "Ava (Premium) en_US # x\nSamantha (English (US)) en_US # x\n";
  const { renderVoiceFile } = await import("@/lib/voice-render");
  const res = await renderVoiceFile("Hello owner.", deps);
  expect(res.cached).toBe(false);
  expect(res.voice).toBe("Ava (Premium)");
  const args = (deps.exec as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: unknown[]) => (c[1] as string[])[0] !== "-v",
  )?.[1] as string[];
  expect(args[0]).toBe("-o");
  expect(args).toContain("-r");
  expect(args[args.indexOf("-r") + 1]).toBe("185");
  expect(args).toContain("Ava (Premium)");
  expect(args).toContain("--data-format=aac");
  expect(args.at(-1)).toBe("Hello owner.");
  expect(res.file.endsWith(`${res.hash}.m4a`)).toBe(true);
});

it("an existing hash is served from cache — say never renders twice", async () => {
  const deps = fakeDeps();
  const { renderVoiceFile } = await import("@/lib/voice-render");
  const first = await renderVoiceFile("Cache me.", deps);
  expect(first.cached).toBe(false);
  const second = await renderVoiceFile("Cache me.", deps);
  expect(second.cached).toBe(true);
  expect(second.hash).toBe(first.hash);
  const renderCallsOnly = deps.execCalls.filter((c) => c.args[0] !== "-v");
  expect(renderCallsOnly).toHaveLength(1);
});

it("prune drops only voice files older than 24h", () => {
  const deps = fakeDeps({
    "fresh.m4a": "new",
    "stale.m4a": "old",
    "notes.txt": "x",
  });
  pruneVoiceFiles("/ignored", deps);
  expect(deps.readdir("/").sort()).toEqual(["fresh.m4a", "notes.txt"]);
});

// --- piper engine (override "piper:<model>") ---

it("piperOverride parses the piper: override and ignores everything else", () => {
  process.env.MWP_VOICE_OVERRIDE = "piper:en_US-amy-medium";
  expect(piperOverride()).toBe("en_US-amy-medium");
  process.env.MWP_VOICE_OVERRIDE = "piper:";
  expect(piperOverride()).toBe(null);
  process.env.MWP_VOICE_OVERRIDE = "Samantha";
  expect(piperOverride()).toBe(null);
  process.env.MWP_VOICE_OVERRIDE = "";
  expect(piperOverride()).toBe(null);
});

it("piperAvailable requires the binary, the .onnx AND the .onnx.json", () => {
  process.env.MWP_PIPER_BIN = "/x/bin/piper";
  process.env.MWP_PIPER_DIR = "/x/models";
  const mk = (names: string[]): VoiceDeps =>
    fakeDeps(Object.fromEntries(names.map((n) => [n, "x"])));
  expect(
    piperAvailable(
      "en_US-amy-medium",
      mk(["piper", "en_US-amy-medium.onnx", "en_US-amy-medium.onnx.json"]),
    ),
  ).toBe(true);
  expect(
    piperAvailable("en_US-amy-medium", mk(["piper", "en_US-amy-medium.onnx"])),
  ).toBe(false);
  expect(
    piperAvailable(
      "en_US-amy-medium",
      mk(["en_US-amy-medium.onnx", "en_US-amy-medium.onnx.json"]),
    ),
  ).toBe(false);
});

it("renders through piper when the override asks — model args, temp input file, afconvert, hash distinct from say", async () => {
  process.env.MWP_PIPER_BIN = "/x/bin/piper";
  process.env.MWP_PIPER_DIR = "/x/models";
  process.env.MWP_VOICE_OVERRIDE = "piper:en_US-amy-medium";
  const deps = fakeDeps({
    piper: "bin",
    "en_US-amy-medium.onnx": "model",
    "en_US-amy-medium.onnx.json": "conf",
  });
  const { renderVoiceFile } = await import("@/lib/voice-render");
  const res = await renderVoiceFile("Neural hello.", deps);
  expect(res.cached).toBe(false);
  expect(res.voice).toBe("piper:en_US-amy-medium");

  const piperCall = deps.execCalls.find(
    (c) => path.basename(c.file) === "piper",
  );
  expect(piperCall?.args[0]).toBe("-m");
  expect(piperCall?.args[1]).toBe("/x/models/en_US-amy-medium.onnx");
  const wav = piperCall?.args[piperCall.args.indexOf("-f") + 1] as string;
  expect(wav.endsWith(".wav")).toBe(true);
  // the text traveled via a temp input file (not argv) and was cleaned up
  const txt = piperCall?.args[piperCall.args.indexOf("-i") + 1] as string;
  expect(deps.readdir(path.dirname(txt))).not.toContain(path.basename(txt));

  const af = deps.execCalls.find((c) => c.file === "afconvert");
  expect(af?.args).toContain("m4af");
  expect(af?.args.at(-1)).toBe(res.file);

  // say never ran, and the piper cache identity differs from say's
  expect(deps.execCalls.some((c) => c.file === "say" && c.args[0] === "-o")).toBe(
    false,
  );
  expect(res.hash).not.toBe(voiceFileHash("Neural hello.", null, 1));
});

it("a missing piper model means the say lane takes over (injected deps)", async () => {
  process.env.MWP_PIPER_BIN = "/x/bin/piper";
  process.env.MWP_PIPER_DIR = "/x/models";
  process.env.MWP_VOICE_OVERRIDE = "piper:en_US-amy-medium";
  const deps = fakeDeps({
    piper: "bin", // model files absent — override flipped before install
  });
  const { renderVoiceFile } = await import("@/lib/voice-render");
  const res = await renderVoiceFile("Still speaks.", deps);
  expect(res.voice).toBe("Samantha (English (US))"); // STUDIO_LISTING pick
  expect(deps.execCalls.some((c) => c.file === "piper")).toBe(false);
});

// --- speed knob (override line 2 → env HONEY_VOICE_SPEED → 1.0) ---

it("voiceSpeedScale: override line 2 wins, env is next, invalid falls through to 1.0", () => {
  // line 2 of the override file is the length-scale divisor
  process.env.MWP_VOICE_OVERRIDE = "piper:en_US-amy-medium\n0.67";
  expect(voiceSpeedScale()).toBe(0.67);
  process.env.HONEY_VOICE_SPEED = "1.5";
  expect(voiceSpeedScale()).toBe(0.67); // the file line beats the env
  process.env.MWP_VOICE_OVERRIDE = "Samantha\n  0.8 "; // padding trims
  expect(voiceSpeedScale()).toBe(0.8);
  process.env.MWP_VOICE_OVERRIDE = "Samantha"; // no line 2
  expect(voiceSpeedScale()).toBe(1.5); // …so the env answers
  process.env.MWP_VOICE_OVERRIDE = "Samantha\nbanana"; // garbage line 2
  expect(voiceSpeedScale()).toBe(1.5); // not a match — env still gets its turn
  process.env.MWP_VOICE_OVERRIDE = "Samantha\n"; // blank line 2, same story
  expect(voiceSpeedScale()).toBe(1.5);
  delete process.env.HONEY_VOICE_SPEED;
  process.env.HONEY_VOICE_SPEED = "0"; // invalid env alone
  expect(voiceSpeedScale()).toBe(1);
  process.env.HONEY_VOICE_SPEED = "-2";
  expect(voiceSpeedScale()).toBe(1);
  process.env.HONEY_VOICE_SPEED = "3"; // bounds are exclusive
  expect(voiceSpeedScale()).toBe(1);
  process.env.HONEY_VOICE_SPEED = "0.2";
  expect(voiceSpeedScale()).toBe(1);
  process.env.HONEY_VOICE_SPEED = "2.99"; // just inside
  expect(voiceSpeedScale()).toBe(2.99);
  process.env.HONEY_VOICE_SPEED = "0.21";
  expect(voiceSpeedScale()).toBe(0.21);
  delete process.env.HONEY_VOICE_SPEED; // missing everywhere
  expect(voiceSpeedScale()).toBe(1);
});

it("a say render converts the scale to wpm (0.67 → -r 276); a speed change is a new file", async () => {
  process.env.MWP_VOICE_OVERRIDE = "Samantha\n0.67";
  const deps = fakeDeps();
  const { renderVoiceFile } = await import("@/lib/voice-render");
  const fast = await renderVoiceFile("Faster please.", deps);
  expect(fast.speed).toBe(0.67);
  expect(fast.cached).toBe(false);
  const args = deps.execCalls.find(
    (c) => c.file === "say" && c.args[0] === "-o",
  )?.args as string[];
  expect(args[args.indexOf("-r") + 1]).toBe("276"); // round(185 / 0.67)
  // the same text at the default speed is a DIFFERENT render — the
  // 0.67 file is never reused for a 1x ask (nor the reverse)
  process.env.MWP_VOICE_OVERRIDE = "Samantha";
  const normal = await renderVoiceFile("Faster please.", deps);
  expect(normal.speed).toBe(1);
  expect(normal.hash).not.toBe(fast.hash);
  expect(normal.cached).toBe(false);
});

it("a piper render passes the scale through as --length_scale", async () => {
  process.env.MWP_PIPER_BIN = "/x/bin/piper";
  process.env.MWP_PIPER_DIR = "/x/models";
  process.env.MWP_VOICE_OVERRIDE = "piper:en_US-amy-medium\n0.67";
  const deps = fakeDeps({
    piper: "bin",
    "en_US-amy-medium.onnx": "model",
    "en_US-amy-medium.onnx.json": "conf",
  });
  const { renderVoiceFile } = await import("@/lib/voice-render");
  const res = await renderVoiceFile("Neural, but quicker.", deps);
  expect(res.speed).toBe(0.67);
  const piperCall = deps.execCalls.find(
    (c) => path.basename(c.file) === "piper",
  );
  expect(piperCall?.args[piperCall.args.indexOf("--length_scale") + 1]).toBe(
    "0.67",
  );
});

// --- the routes (mocked child_process + real fs in the scratch dir) ---

it("POST render answers a same-origin playable url and caches the second ask", async () => {
  const res1 = await post({ text: "Reply number one.", sessionHint: "t1" });
  expect(res1.status).toBe(200);
  const body1 = await res1.json();
  expect(body1.cached).toBe(false);
  expect(body1.voice).toBe("Samantha (English (US))"); // this Studio's pick
  expect(body1.url).toMatch(/^\/api\/cockpit\/voice\/audio\?id=[a-f0-9]{64}\.m4a$/);
  expect(fs.existsSync(path.join(voiceDir, body1.url.split("id=")[1]))).toBe(true);

  const res2 = await post({ text: "Reply number one.", sessionHint: "t2" });
  const body2 = await res2.json();
  expect(body2.cached).toBe(true);
  expect(body2.url).toBe(body1.url);
  expect(renderCalls()).toHaveLength(1); // say ran once, ever
});

it("POST render sanitizes + caps what say speaks (defense in depth)", async () => {
  await post({ text: "dirty\u0000text" });
  const spoken = renderCalls()[0]?.args.at(-1);
  expect(spoken).toBe("dirty text");
  const long = "sentence. ".repeat(600);
  await post({ text: long });
  const capped = renderCalls()[1]?.args.at(-1) as string;
  expect(capped.endsWith("Message continues on screen.")).toBe(true);
  expect(capped.length).toBeLessThanOrEqual(VOICE_TEXT_CAP_CHARS + 40);
});

it("POST render prunes files older than 24h on each render", async () => {
  await post({ text: "First reply." });
  // age every rendered file past the 24h line
  const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
  for (const f of fs.readdirSync(voiceDir)) {
    fs.utimesSync(path.join(voiceDir, f), past, past);
  }
  await post({ text: "Second reply." });
  const left = fs.readdirSync(voiceDir);
  expect(left).toHaveLength(1); // only the fresh render survives
});

it("POST render rejects malformed bodies and reports a failed say visibly", async () => {
  expect((await post({})).status).toBe(400);
  expect((await post({ text: "   " })).status).toBe(400);
  expect((await post({ text: "ok", sessionHint: 7 })).status).toBe(400);
  expect((await post({ text: "ok", sessionHint: "y".repeat(201) })).status).toBe(400);
  hoisted.failRenders = true;
  const fail = await post({ text: "This render will fail." });
  expect(fail.status).toBe(500);
  expect(((await fail.json()) as { error: string }).error).toContain("say");
});

// --- the routes, piper engine (override "piper:<model>") ---

it("POST render uses piper when the override selects it — voice, url, cache hit skips piper", async () => {
  installFakePiper();
  process.env.MWP_VOICE_OVERRIDE = "piper:en_US-amy-medium";

  const res1 = await post({ text: "Neural reply one." });
  expect(res1.status).toBe(200);
  const body1 = await res1.json();
  expect(body1.voice).toBe("piper:en_US-amy-medium");
  expect(body1.url).toMatch(/^\/api\/cockpit\/voice\/audio\?id=[a-f0-9]{64}\.m4a$/);
  const id = body1.url.split("id=")[1] as string;
  expect(fs.readFileSync(path.join(voiceDir, id)).toString()).toBe("fake-aac-bytes");

  expect(piperCalls()).toHaveLength(1);
  expect(piperCalls()[0]?.args[0]).toBe("-m");
  expect(piperCalls()[0]?.args[1]).toBe(path.join(piperDir, "en_US-amy-medium.onnx"));
  // only the .m4a remains — temp txt/wav are cleaned up after the render
  expect(fs.readdirSync(voiceDir)).toEqual([id]);
  expect(sayRenderCalls()).toHaveLength(0); // say never touched

  const res2 = await post({ text: "Neural reply one." });
  expect(((await res2.json()) as { cached: boolean }).cached).toBe(true);
  expect(piperCalls()).toHaveLength(1); // cache hit — piper never ran again
});

it("a piper failure mid-render falls back to say with a warning — the note still lands", async () => {
  installFakePiper();
  process.env.MWP_VOICE_OVERRIDE = "piper:en_US-amy-medium";
  hoisted.failPiper = true;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const res = await post({ text: "Fallback render." });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.voice).toBe("Samantha (English (US))");
  expect(fs.existsSync(path.join(voiceDir, body.url.split("id=")[1]))).toBe(true);
  expect(piperCalls()).toHaveLength(1);
  expect(sayRenderCalls()).toHaveLength(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain("falling back to say");
  warn.mockRestore();
});

it("a missing piper binary/model falls back to say without invoking piper at all", async () => {
  // env seams point into the scratch tree, but nothing is installed there
  process.env.MWP_PIPER_BIN = piperBinPath;
  process.env.MWP_PIPER_DIR = piperDir;
  fs.mkdirSync(piperDir, { recursive: true });
  process.env.MWP_VOICE_OVERRIDE = "piper:en_US-amy-medium";
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const res = await post({ text: "Model missing render." });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { voice: string }).voice).toBe(
    "Samantha (English (US))",
  );
  expect(piperCalls()).toHaveLength(0);
  expect(sayRenderCalls()).toHaveLength(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain("missing");
  warn.mockRestore();
});

it("an afconvert failure also falls back to say", async () => {
  installFakePiper();
  process.env.MWP_VOICE_OVERRIDE = "piper:en_US-amy-medium";
  hoisted.failAfconvert = true;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const res = await post({ text: "Afconvert failure render." });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { voice: string }).voice).toBe(
    "Samantha (English (US))",
  );
  expect(piperCalls()).toHaveLength(1); // piper ran, afconvert broke it
  expect(sayRenderCalls()).toHaveLength(1);
  warn.mockRestore();
});

it("POST render reports the speed and never reuses a 1x file for a 1.5x ask", async () => {
  installFakePiper();
  process.env.MWP_VOICE_OVERRIDE = "piper:en_US-amy-medium\n0.67";
  const res1 = await post({ text: "Speed knob route check." });
  expect(res1.status).toBe(200);
  const body1 = await res1.json();
  expect(body1.speed).toBe(0.67);
  expect(body1.voice).toBe("piper:en_US-amy-medium");
  expect(piperCalls()[0]?.args).toContain("--length_scale");
  expect(piperCalls()[0]?.args[piperCalls()[0].args.indexOf("--length_scale") + 1]).toBe(
    "0.67",
  );

  // same text, default speed → different hash, piper renders again
  process.env.MWP_VOICE_OVERRIDE = "piper:en_US-amy-medium";
  const res2 = await post({ text: "Speed knob route check." });
  const body2 = await res2.json();
  expect(body2.speed).toBe(1);
  expect(body2.cached).toBe(false);
  expect(body2.url).not.toBe(body1.url);
  expect(piperCalls()).toHaveLength(2);

  // and back at 0.67 the first answer is a cache hit, not a re-render
  process.env.MWP_VOICE_OVERRIDE = "piper:en_US-amy-medium\n0.67";
  const res3 = await post({ text: "Speed knob route check." });
  const body3 = await res3.json();
  expect(body3.url).toBe(body1.url);
  expect(body3.cached).toBe(true);
  expect(piperCalls()).toHaveLength(2);
});

it("GET audio serves bytes with range support and safe ids", async () => {
  const rendered = await post({ text: "Range test reply." });
  const { url } = await rendered.json();
  const id = url.split("id=")[1];

  const full = await get(id);
  expect(full.status).toBe(200);
  expect(full.headers.get("content-type")).toBe("audio/mp4");
  expect(full.headers.get("accept-ranges")).toBe("bytes");
  expect(Buffer.from(await full.arrayBuffer()).toString()).toBe("fake-aac-bytes");

  const partial = await get(id, "bytes=5-8");
  expect(partial.status).toBe(206);
  expect(partial.headers.get("content-range")).toBe(
    `bytes 5-8/${"fake-aac-bytes".length}`,
  );
  expect(Buffer.from(await partial.arrayBuffer()).toString()).toBe("aac-");

  expect((await get("../etc/passwd")).status).toBe(400);
  expect((await get("deadbeef.m4a")).status).toBe(400); // wrong-length id
  expect((await get(`${"a".repeat(64)}.m4a`)).status).toBe(404); // well-formed, missing
});
