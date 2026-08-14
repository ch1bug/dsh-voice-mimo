/**
 * dsh-voice-mimo — shared TTS logic tests: voice resolution (preset /
 * voicedesign / voiceclone semantics shared with voice_speak) and the
 * node-fetch MiMo speak transport (mock fetch injected).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTtsTarget, speakMiMo, PRESET_VOICES, DEFAULT_READ_ALOUD_VOICE } from "../lib/tts.js";

const VOICE_MAP = {
  alloy: { type: "preset", voice: "冰糖" },
  echo: { type: "preset", voice: "苏打", model: "mimo-v2.5-tts-voiceclone" },
  fable: { type: "voicedesign", voice: "温柔的女声" },
  nova: { type: "preset", voice: "mimo_default", model: "mimo-v2.5-tts" },
  raw: { type: "preset", voice: "低沉男声" }, // not a preset → voicedesign fallback
};

test("PRESET_VOICES contains the documented presets", () => {
  for (const v of ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dea"]) {
    assert.ok(PRESET_VOICES.has(v));
  }
  assert.equal(DEFAULT_READ_ALOUD_VOICE, "alloy");
});

test("resolveTtsTarget: preset voice → mimo-v2.5-tts with audio.voice", () => {
  const t = resolveTtsTarget({ model: "mimo-v2.5-tts" }, VOICE_MAP, "alloy");
  assert.equal(t.model, "mimo-v2.5-tts");
  assert.equal(t.audio.voice, "冰糖");
  assert.equal(t.audio.format, "wav");
  assert.equal(t.needsReference, false);
});

test("resolveTtsTarget: unknown voice name falls back to mimo_default preset", () => {
  const t = resolveTtsTarget({ model: "mimo-v2.5-tts" }, VOICE_MAP, "does-not-exist");
  assert.equal(t.model, "mimo-v2.5-tts");
  assert.equal(t.audio.voice, "mimo_default");
});

test("resolveTtsTarget: direct preset name as voice name", () => {
  const t = resolveTtsTarget({ model: "mimo-v2.5-tts" }, {}, "苏打");
  assert.equal(t.audio.voice, "苏打");
  assert.equal(t.model, "mimo-v2.5-tts");
});

test("resolveTtsTarget: voicedesign → -voicedesign model with optimize_text_preview", () => {
  const t = resolveTtsTarget({}, VOICE_MAP, "fable");
  assert.equal(t.model, "mimo-v2.5-tts-voicedesign");
  assert.equal(t.userContent, "温柔的女声");
  assert.equal(t.audio.optimize_text_preview, true);
  assert.equal(t.audio.voice, undefined);
});

test("resolveTtsTarget: non-preset voice string → voicedesign fallback", () => {
  const t = resolveTtsTarget({}, VOICE_MAP, "raw");
  assert.equal(t.model, "mimo-v2.5-tts-voicedesign");
  assert.equal(t.userContent, "低沉男声");
});

test("resolveTtsTarget: model override wins for preset", () => {
  const t = resolveTtsTarget({ model: "mimo-v2.5-tts" }, VOICE_MAP, "nova");
  assert.equal(t.model, "mimo-v2.5-tts");
  assert.equal(t.audio.voice, "mimo_default");
});

test("resolveTtsTarget: voiceclone model → needsReference, no audio.voice yet", () => {
  const t = resolveTtsTarget({}, VOICE_MAP, "echo");
  assert.equal(t.model, "mimo-v2.5-tts-voiceclone");
  assert.equal(t.needsReference, true);
  assert.deepEqual(t.audio, { format: "wav" });
});

test("resolveTtsTarget: default model from tts config", () => {
  const t = resolveTtsTarget({ model: "my-tts-model" }, { alloy: { type: "preset", voice: "冰糖" } }, "alloy");
  assert.equal(t.model, "my-tts-model");
});

function mockFetch(handler) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    return handler(url, init, body);
  };
}

function okResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

test("speakMiMo: posts to chat/completions and decodes base64 audio", async () => {
  const calls = [];
  const audioB64 = Buffer.from("RIFF....WAVE data").toString("base64");
  const fetchImpl = mockFetch((url, init, body) => {
    calls.push({ url, headers: init.headers, body });
    return okResponse({ choices: [{ message: { audio: { data: audioB64 } } }] });
  });
  const out = await speakMiMo({
    baseUrl: "https://api.xiaomimimo.com/v1/",
    apiKey: "secret-key",
    target: { model: "mimo-v2.5-tts", userContent: "Speak the following text naturally.", audio: { voice: "冰糖" } },
    text: "你好世界",
    fetchImpl,
  });
  assert.equal(out.bytes.toString("utf8"), "RIFF....WAVE data");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.xiaomimimo.com/v1/chat/completions");
  assert.equal(calls[0].headers["api-key"], "secret-key");
  assert.equal(calls[0].body.model, "mimo-v2.5-tts");
  assert.equal(calls[0].body.messages[0].content, "Speak the following text naturally.");
  assert.equal(calls[0].body.messages[1].content, "你好世界");
  assert.deepEqual(calls[0].body.audio, { format: "wav", voice: "冰糖" });
});

test("speakMiMo: forces format onto the audio payload", async () => {
  let captured;
  const fetchImpl = mockFetch((_u, _i, body) => { captured = body; return okResponse({ choices: [{ message: { audio: { data: Buffer.from("x").toString("base64") } } }] }); });
  await speakMiMo({ baseUrl: "u", apiKey: "k", target: { model: "m", userContent: "u", audio: { voice: "冰糖" } }, text: "t", format: "mp3", fetchImpl });
  assert.deepEqual(captured.audio, { format: "mp3", voice: "冰糖" });
});

test("speakMiMo: HTTP error surfaces status + body", async () => {
  const fetchImpl = mockFetch(() => ({ ok: false, status: 429, text: async () => "rate limited" }));
  await assert.rejects(
    speakMiMo({ baseUrl: "u", apiKey: "k", target: { model: "m", userContent: "u", audio: {} }, text: "t", fetchImpl }),
    /MiMo TTS HTTP 429: rate limited/,
  );
});

test("speakMiMo: missing audio data throws", async () => {
  const fetchImpl = mockFetch(() => okResponse({ choices: [{ message: { content: "no audio" } }] }));
  await assert.rejects(
    speakMiMo({ baseUrl: "u", apiKey: "k", target: { model: "m", userContent: "u", audio: {} }, text: "t", fetchImpl }),
    /returned no audio data/,
  );
});

test("speakMiMo: network failure is wrapped", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(
    speakMiMo({ baseUrl: "u", apiKey: "k", target: { model: "m", userContent: "u", audio: {} }, text: "t", fetchImpl }),
    /MiMo TTS request failed: ECONNREFUSED/,
  );
});
