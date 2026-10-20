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
  pruneVoiceFiles,
  resetVoiceRenderCaches,
  sanitizeVoiceText,
  voiceFileHash,
  type SayVoice,
  type VoiceDeps,
} from "@/lib/voice-render";
import { POST as renderPOST } from "@/app/api/cockpit/voice/render/route";
import { GET as audioGET } from "@/app/api/cockpit/voice/audio/route";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "voice-notes-test-"));
const voiceDir = path.join(scratch, "voice");

beforeEach(() => {
  process.env.MWP_VOICE_DIR = voiceDir;
  hoisted.listing = STUDIO_LISTING; // reset per test — no leak
  hoisted.sayCalls.length = 0;
  hoisted.failRenders = false;
  resetVoiceRenderCaches();
  fs.rmSync(voiceDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.MWP_VOICE_DIR;
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
  return hoisted.sayCalls.filter((c) => c.args[0] !== "-v");
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

it("the hash is deterministic and sensitive to voice and text", () => {
  const a = voiceFileHash("hello", "Samantha (English (US))");
  expect(a).toBe(voiceFileHash("hello", "Samantha (English (US))"));
  expect(a).not.toBe(voiceFileHash("hello", null));
  expect(a).not.toBe(voiceFileHash("hello!", "Samantha (English (US))"));
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
