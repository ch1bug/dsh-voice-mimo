/**
 * dsh-voice-mimo — audio-store unit tests (node:test, no external deps).
 * Pure file-system logic: audioDir resolution, tmp/long init, idempotent
 * startup cleanup, JSONL manifest append/find, path confinement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANIFEST_NAME,
  defaultAudioDir,
  resolveAudioDir,
  initAudioStore,
  cleanTmp,
  newAudioId,
  manifestAppend,
  manifestEntries,
  manifestFind,
  confinePath,
  entryAbsolutePath,
  tmpStats,
  wavDurationSeconds,
  planSpeechArtifact,
  wslPathOf,
} from "../lib/audio-store.js";

/** Build a minimal PCM WAV buffer: optional JUNK chunk, fmt (+ cbSize) + data. */
function buildWav({ channels = 1, sampleRate = 24000, bits = 16, dataBytes = 48000, fmtExtra = false, junkBeforeFmt = false } = {}) {
  const fmtSize = fmtExtra ? 18 : 16;
  const junkSize = junkBeforeFmt ? 12 : 0; // JUNK payload, word-aligned
  const fmtStart = 12 + (junkSize ? 8 + junkSize : 0);
  const dataStart = fmtStart + 8 + fmtSize; // both branches word-aligned
  const total = dataStart + 8 + dataBytes;
  const buf = Buffer.alloc(total);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(total - 8, 4);
  buf.write("WAVE", 8, "ascii");
  if (junkBeforeFmt) {
    buf.write("JUNK", 12, "ascii");
    buf.writeUInt32LE(junkSize, 16);
  }
  buf.write("fmt ", fmtStart, "ascii");
  buf.writeUInt32LE(fmtSize, fmtStart + 4);
  buf.writeUInt16LE(1, fmtStart + 8); // PCM
  buf.writeUInt16LE(channels, fmtStart + 10);
  buf.writeUInt32LE(sampleRate, fmtStart + 12);
  buf.writeUInt32LE(sampleRate * channels * (bits / 8), fmtStart + 16);
  buf.writeUInt16LE(channels * (bits / 8), fmtStart + 20);
  buf.writeUInt16LE(bits, fmtStart + 22);
  if (fmtExtra) buf.writeUInt16LE(0, fmtStart + 8 + fmtSize - 2); // cbSize
  buf.write("data", dataStart, "ascii");
  buf.writeUInt32LE(dataBytes, dataStart + 4);
  return buf;
}

async function tempAudioDir() {
  const root = await mkdtemp(join(tmpdir(), "voice-mimo-store-"));
  return join(root, "audio");
}

test("resolveAudioDir: default under dshHome/cache/voice-mimo", () => {
  assert.equal(resolveAudioDir({}, "/home/u/.dsh"), "/home/u/.dsh/cache/voice-mimo");
});

test("resolveAudioDir: empty/whitespace dir falls back to default", () => {
  assert.equal(resolveAudioDir({ audio: { dir: "  " } }, "/h/.dsh"), "/h/.dsh/cache/voice-mimo");
});

test("resolveAudioDir: explicit dir wins", () => {
  assert.equal(resolveAudioDir({ audio: { dir: "/data/audio" } }, "/h/.dsh"), "/data/audio");
});

test("resolveAudioDir: Windows path is converted to WSL", () => {
  const out = resolveAudioDir({ audio: { dir: "C:\\Users\\me\\audio" } }, "/h/.dsh");
  assert.equal(out, "/mnt/c/Users/me/audio");
});

test("wslPathOf: Windows and WSL forms normalize the same", () => {
  assert.equal(wslPathOf("C:\\Windows\\Temp\\x.wav"), "/mnt/c/Windows/Temp/x.wav");
  assert.equal(wslPathOf("/mnt/c/windows/x.wav"), "/mnt/c/windows/x.wav");
});

test("initAudioStore: creates tmp/ + long/ idempotently", async () => {
  const dir = await tempAudioDir();
  await initAudioStore(dir);
  await initAudioStore(dir); // second call must not throw
  const entries = await readdir(dir);
  assert.ok(entries.includes("tmp"));
  assert.ok(entries.includes("long"));
});

test("cleanTmp: removes previous tmp contents, idempotent, never touches long/", async () => {
  const dir = await tempAudioDir();
  await initAudioStore(dir);
  await mkdir(join(dir, "tmp", "sub"), { recursive: true });
  await writeFile(join(dir, "tmp", "a.wav"), "aaa");
  await writeFile(join(dir, "tmp", "sub", "b.wav"), "bbb");
  await writeFile(join(dir, "long", "keep.wav"), "keep");
  await cleanTmp(dir);
  assert.deepEqual(await readdir(join(dir, "tmp")), []);
  assert.deepEqual(await readdir(join(dir, "long")), ["keep.wav"]);
  await cleanTmp(dir); // already clean → no-op
  assert.deepEqual(await readdir(join(dir, "tmp")), []);
});

test("newAudioId: unique, .wav, safe charset", () => {
  const a = newAudioId();
  const b = newAudioId();
  assert.notEqual(a, b);
  assert.match(a, /^m-[A-Za-z0-9-]+\.wav$/);
});

test("manifestAppend/Entries/Find: append-only JSONL round-trip", async () => {
  const dir = await tempAudioDir();
  await initAudioStore(dir);
  await manifestAppend(dir, { id: "m-1.wav", rel: "tmp/m-1.wav", text: "你好", voice: "alloy", model: "mimo-v2.5-tts" });
  await manifestAppend(dir, { id: "m-2.wav", rel: "long/m-2.wav", sessionId: "s1", callId: "c1", notify: true, style: "温柔" });
  const entries = await manifestEntries(dir);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "m-1.wav");
  assert.equal(entries[0].path, "tmp/m-1.wav");
  assert.equal(entries[0].createdAt.length > 0, true);
  assert.equal(entries[1].sessionId, "s1");
  assert.equal(entries[1].notify, true);
  assert.equal(entries[1].style, "温柔"); // style persists to the manifest (spec #6)
  const found = await manifestFind(dir, "m-2.wav");
  assert.equal(found.callId, "c1");
  assert.equal(await manifestFind(dir, "nope.wav"), null);
  // corrupt line is skipped, good lines survive
  const raw = await readFile(join(dir, MANIFEST_NAME), "utf8");
  await writeFile(join(dir, MANIFEST_NAME), raw + "{not json}\n");
  assert.equal((await manifestEntries(dir)).length, 2);
});

test("manifestEntries: missing manifest → empty", async () => {
  const dir = await tempAudioDir();
  assert.deepEqual(await manifestEntries(dir), []);
});

test("confinePath: rejects traversal outside audioDir", () => {
  const dir = "/data/audio";
  assert.equal(confinePath(dir, "tmp/x.wav"), "/data/audio/tmp/x.wav");
  assert.throws(() => confinePath(dir, "../evil.wav"));
  assert.throws(() => confinePath(dir, "tmp/../../evil.wav"));
  assert.throws(() => confinePath(dir, "/etc/passwd"));
  assert.throws(() => confinePath(dir, ""));
});

test("entryAbsolutePath: resolves manifest path confined", async () => {
  const dir = await tempAudioDir();
  await initAudioStore(dir);
  await writeFile(join(dir, "tmp", "m-9.wav"), "data");
  const entry = { id: "m-9.wav", path: "tmp/m-9.wav" };
  assert.equal(entryAbsolutePath(dir, entry), join(dir, "tmp", "m-9.wav"));
  assert.throws(() => entryAbsolutePath(dir, { path: "../escape.wav" }));
  assert.throws(() => entryAbsolutePath(dir, null));
});

test("tmpStats: counts entries and bytes", async () => {
  const dir = await tempAudioDir();
  await initAudioStore(dir);
  assert.deepEqual(await tmpStats(dir), { entries: 0, bytes: 0 });
  await writeFile(join(dir, "tmp", "a.wav"), "12345");
  const stats = await tmpStats(dir);
  assert.equal(stats.entries, 1);
  assert.equal(stats.bytes, 5);
});

test("defaultAudioDir: join under home", () => {
  assert.equal(defaultAudioDir("/home/u/.dsh"), "/home/u/.dsh/cache/voice-mimo");
});

// ── wavDurationSeconds: WAV header parsing (#3) ──

test("wavDurationSeconds: mono 24kHz 16-bit 1s", () => {
  assert.equal(wavDurationSeconds(buildWav({ dataBytes: 48000 })), 1);
});

test("wavDurationSeconds: stereo 48kHz 16-bit 1s", () => {
  assert.equal(wavDurationSeconds(buildWav({ channels: 2, sampleRate: 48000, dataBytes: 192000 })), 1);
});

test("wavDurationSeconds: 8-bit mono 8kHz 2s", () => {
  assert.equal(wavDurationSeconds(buildWav({ bits: 8, sampleRate: 8000, dataBytes: 16000 })), 2);
});

test("wavDurationSeconds: fmt with cbSize extension still parses", () => {
  assert.equal(wavDurationSeconds(buildWav({ fmtExtra: true, dataBytes: 48000 })), 1);
});

test("wavDurationSeconds: JUNK chunk before fmt is scanned past", () => {
  assert.equal(wavDurationSeconds(buildWav({ junkBeforeFmt: true, dataBytes: 48000 })), 1);
});

test("wavDurationSeconds: non-PCM audioFormat (e.g. IEEE float 3) → 0", () => {
  const buf = buildWav({ dataBytes: 48000 });
  buf.writeUInt16LE(3, 20); // audioFormat = IEEE float
  assert.equal(wavDurationSeconds(buf), 0);
});

test("wavDurationSeconds: truncated / non-WAV / too short → 0", () => {
  assert.equal(wavDurationSeconds(Buffer.alloc(10)), 0);
  assert.equal(wavDurationSeconds(Buffer.from("not a wav file at all")), 0);
  const junk = buildWav({ dataBytes: 48000 });
  junk.write("XXXX", 0, "ascii"); // corrupt RIFF magic
  assert.equal(wavDurationSeconds(junk), 0);
  assert.equal(wavDurationSeconds(null), 0);
  assert.equal(wavDurationSeconds(Buffer.alloc(0)), 0);
});

// ── planSpeechArtifact: long/ + manifest vs explicit outPath (#3) ──

test("planSpeechArtifact: no outPath → long/ + manifest entry", () => {
  const plan = planSpeechArtifact({
    outPath: null,
    audioDir: "/data/audio",
    id: "m-x.wav",
    text: "你好",
    voice: "alloy",
    model: "mimo-v2.5-tts",
    notify: true,
    sessionId: "s1",
    callId: "c1",
    style: "温柔",
  });
  assert.equal(plan.path, "/data/audio/long/m-x.wav");
  assert.deepEqual(plan.manifest, {
    id: "m-x.wav",
    rel: "long/m-x.wav",
    sessionId: "s1",
    callId: "c1",
    text: "你好",
    voice: "alloy",
    model: "mimo-v2.5-tts",
    notify: true,
    style: "温柔",
  });
});

test("planSpeechArtifact: explicit outPath → caller path, no manifest", () => {
  const plan = planSpeechArtifact({
    outPath: "/mnt/c/Users/me/out.wav",
    audioDir: "/data/audio",
    id: "m-x.wav",
    text: "hi",
    voice: "alloy",
    model: "mimo-v2.5-tts",
    notify: false,
    sessionId: "s1",
    callId: "c1",
  });
  assert.equal(plan.path, "/mnt/c/Users/me/out.wav");
  assert.equal(plan.manifest, null);
});

test("planSpeechArtifact: non-string sessionId/callId are coerced to null (regression)", () => {
  const plan = planSpeechArtifact({
    outPath: null,
    audioDir: "/data/audio",
    id: "m-x.wav",
    text: "t",
    voice: "v",
    model: "m",
    notify: false,
    sessionId: { some: "object" }, // what exec.agent.session used to be
    callId: 42,
  });
  assert.equal(plan.manifest.sessionId, null);
  assert.equal(plan.manifest.callId, null);
});
