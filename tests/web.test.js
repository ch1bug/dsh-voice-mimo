/**
 * dsh-voice-mimo — host route logic tests (issue #2 seam).
 * performSpeak / performAudio are the core of POST /speak and
 * GET /audio/<id>.wav: synthesized wav lands in audioDir/tmp (never long/),
 * manifest entry is recorded, and the audio endpoint resolves it confined.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performSpeak, performAudio, parseAudioId, speakHttp, audioHttp, AudioLookupError } from "../lib/web.js";
import { manifestFind, resolveAudioDir, tmpStats } from "../lib/audio-store.js";

async function makeDeps() {
  const root = await mkdtemp(join(tmpdir(), "voice-mimo-web-"));
  const audioDir = join(root, "audio");
  const settings = {
    value: {
      provider: { baseUrl: "https://api.xiaomimimo.com/v1", credential: "XIAOMI_API_KEY" },
      voiceMap: { alloy: { type: "preset", voice: "冰糖" } },
      tts: { model: "mimo-v2.5-tts", format: "wav", timeoutMs: 60000, voice: "alloy" },
      audio: { dir: audioDir },
    },
    revision: 1,
    writable: true,
  };
  const ctx = {
    get: (name) => (name === "credentials" ? { resolve: async () => ({ value: "test-key" }) } : undefined),
  };
  const getSettings = () => settings;
  return { ctx, getSettings, audioDir, root };
}

function okFetch(audioBytes) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { audio: { data: Buffer.from(audioBytes).toString("base64") } } }] }),
  });
}

test("performSpeak: synthesizes into tmp/, returns audioUrl, records manifest", async () => {
  const { ctx, getSettings, audioDir } = await makeDeps();
  const result = await performSpeak(ctx, getSettings, { text: " 你好世界 " }, { fetchImpl: okFetch("RIFF...WAVE") });
  assert.equal(result.bytes, 11);
  assert.equal(result.voice, "alloy");
  assert.equal(result.model, "mimo-v2.5-tts");
  assert.match(result.audioUrl, /^\/_dsh\/voice-mimo\/audio\/m-[A-Za-z0-9-]+\.wav$/);
  const id = result.audioUrl.split("/").pop();
  // file is in tmp/ (read-aloud: play-once, discard), NOT long/
  assert.equal((await readFile(join(audioDir, "tmp", id), "utf8")), "RIFF...WAVE");
  assert.deepEqual(await readdir(join(audioDir, "long")), []);
  const entry = await manifestFind(audioDir, id);
  assert.equal(entry.path, `tmp/${id}`);
  assert.equal(entry.text, "你好世界");
  assert.equal(entry.voice, "alloy");
  assert.equal(entry.model, "mimo-v2.5-tts");
  assert.equal(entry.notify, false);
});

test("performSpeak: explicit voice override wins over settings; settings change applies live", async () => {
  const { ctx, getSettings } = await makeDeps();
  // settings 朗读音色 = alloy
  const a = await performSpeak(ctx, getSettings, { text: "hi" }, { fetchImpl: okFetch("x") });
  assert.equal(a.voice, "alloy");
  // explicit voice param overrides settings
  const b = await performSpeak(ctx, getSettings, { text: "hi", voice: "fable" }, { fetchImpl: okFetch("x") });
  assert.equal(b.voice, "fable");
  // changing settings tts.voice applies on the next call (立即生效)
  getSettings().value.voiceMap.fable = { type: "voicedesign", voice: "温柔的女声" };
  getSettings().value.tts.voice = "fable";
  const c = await performSpeak(ctx, getSettings, { text: "hi" }, { fetchImpl: okFetch("x") });
  assert.equal(c.voice, "fable");
  assert.equal(c.model, "mimo-v2.5-tts-voicedesign");
});

test("performSpeak: empty text rejected", async () => {
  const { ctx, getSettings } = await makeDeps();
  await assert.rejects(performSpeak(ctx, getSettings, { text: "   " }, { fetchImpl: okFetch("x") }), /text is required/);
});

test("performSpeak: voiceclone 朗读音色 without reference → friendly error", async () => {
  const { ctx, getSettings } = await makeDeps();
  getSettings().value.voiceMap.echo = { type: "preset", voice: "苏打", model: "mimo-v2.5-tts-voiceclone" };
  getSettings().value.tts.voice = "echo";
  await assert.rejects(
    performSpeak(ctx, getSettings, { text: "hi" }, { fetchImpl: okFetch("x") }),
    /朗读音色 "echo" 映射到 voiceclone 模型/,
  );
});

test("performSpeak: MiMo HTTP error propagates with status", async () => {
  const { ctx, getSettings } = await makeDeps();
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => "boom" });
  await assert.rejects(performSpeak(ctx, getSettings, { text: "hi" }, { fetchImpl }), /MiMo TTS HTTP 500: boom/);
});

test("performSpeak: missing credential → clear error", async () => {
  const { ctx, getSettings } = await makeDeps();
  ctx.get = () => undefined;
  await assert.rejects(performSpeak(ctx, getSettings, { text: "hi" }, { fetchImpl: okFetch("x") }), /credentials service is unavailable/);
});

test("performAudio: resolves a synthesized id to the confined file", async () => {
  const { ctx, getSettings, audioDir } = await makeDeps();
  const { audioUrl } = await performSpeak(ctx, getSettings, { text: "hi" }, { fetchImpl: okFetch("WAVDATA") });
  const id = audioUrl.split("/").pop();
  const out = await performAudio(ctx, getSettings, id);
  assert.equal(out.path, join(audioDir, "tmp", id));
  assert.equal(out.bytes, 7);
  assert.equal((await readFile(out.path, "utf8")), "WAVDATA");
});

test("performAudio: unknown id → not found", async () => {
  const { ctx, getSettings } = await makeDeps();
  await assert.rejects(performAudio(ctx, getSettings, "m-nope.wav"), /not found/);
});

test("performAudio: traversal id rejected by pattern", async () => {
  const { ctx, getSettings } = await makeDeps();
  for (const evil of ["../settings.yaml", "..%2F..%2Fetc%2Fpasswd", "m-1.wav/../../x", "a.wav?x=1"]) {
    await assert.rejects(performAudio(ctx, getSettings, evil), /invalid audio id/);
  }
});

test("parseAudioId: strict wav pattern", () => {
  assert.equal(parseAudioId("m-abc123.wav"), "m-abc123.wav");
  assert.throws(() => parseAudioId("m-1.mp3"));
  assert.throws(() => parseAudioId(""));
  assert.throws(() => parseAudioId(null));
});

test("speak leaves tmp countable via tmpStats", async () => {
  const { ctx, getSettings, audioDir } = await makeDeps();
  await performSpeak(ctx, getSettings, { text: "one" }, { fetchImpl: okFetch("x") });
  const stats = await tmpStats(audioDir);
  assert.equal(stats.entries, 1);
  assert.equal(stats.bytes, 1);
});

// ── HTTP decision layer (speakHttp / audioHttp): status + JSON mapping ──

test("speakHttp: missing/empty text → 400 invalid-request", async () => {
  const { ctx, getSettings } = await makeDeps();
  for (const body of [null, {}, { text: "" }, { text: "   " }, { text: 42 }]) {
    const out = await speakHttp(ctx, getSettings, body, { fetchImpl: okFetch("x") });
    assert.equal(out.status, 400);
    assert.equal(out.json.error.code, "invalid-request");
  }
});

test("speakHttp: success → 200 with audioUrl; MiMo failure → 500 speak-error", async () => {
  const { ctx, getSettings } = await makeDeps();
  const ok = await speakHttp(ctx, getSettings, { text: "你好" }, { fetchImpl: okFetch("WAV") });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.match(ok.json.value.audioUrl, /^\/_dsh\/voice-mimo\/audio\//);
  const fail = await speakHttp(ctx, getSettings, { text: "你好" }, {
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }),
  });
  assert.equal(fail.status, 500);
  assert.equal(fail.json.error.code, "speak-error");
  assert.match(fail.json.error.message, /MiMo TTS HTTP 500/);
});

test("audioHttp: unknown/invalid id → 404; real fs failure → 500", async () => {
  const { ctx, getSettings, audioDir } = await makeDeps();
  const missing = await audioHttp(ctx, getSettings, "m-nope.wav");
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "audio-not-found");
  const evil = await audioHttp(ctx, getSettings, "../settings.yaml");
  assert.equal(evil.status, 404);
  // manifest entry whose file was deleted → 404 (not a crash)
  const { audioUrl } = await performSpeak(ctx, getSettings, { text: "hi" }, { fetchImpl: okFetch("x") });
  const id = audioUrl.split("/").pop();
  await rm(join(audioDir, "tmp", id));
  const gone = await audioHttp(ctx, getSettings, id);
  assert.equal(gone.status, 404);
});

test("audioHttp: success → 200 with path + bytes", async () => {
  const { ctx, getSettings } = await makeDeps();
  const { audioUrl } = await performSpeak(ctx, getSettings, { text: "hi" }, { fetchImpl: okFetch("WAVDATA") });
  const id = audioUrl.split("/").pop();
  const out = await audioHttp(ctx, getSettings, id);
  assert.equal(out.status, 200);
  assert.equal(out.bytes, 7);
  assert.equal((await readFile(out.path, "utf8")), "WAVDATA");
});

test("AudioLookupError: distinguish missing (404) from io (500)", async () => {
  assert.ok(new AudioLookupError("not-found", "x") instanceof Error);
  assert.equal(new AudioLookupError("not-found", "x").code, "not-found");
});

// ── #3: long-term (agent voice_speak) artifacts are served by /audio ──

test("audioHttp: long/ manifest artifact streams like tmp/", async () => {
  const { ctx, getSettings, audioDir } = await makeDeps();
  const { manifestAppend, initAudioStore } = await import("../lib/audio-store.js");
  const { writeFile, mkdir } = await import("node:fs/promises");
  await initAudioStore(audioDir);
  const id = "m-long.wav";
  await mkdir(join(audioDir, "long"), { recursive: true });
  await writeFile(join(audioDir, "long", id), "LONGDATA");
  await manifestAppend(audioDir, { id, rel: `long/${id}`, sessionId: "s1", callId: "c1", text: "hi", voice: "alloy", model: "m", notify: false });
  const out = await audioHttp(ctx, getSettings, id);
  assert.equal(out.status, 200);
  assert.equal(out.bytes, 8);
  assert.equal(out.path, join(audioDir, "long", id));
  assert.equal((await readFile(out.path, "utf8")), "LONGDATA");
});
