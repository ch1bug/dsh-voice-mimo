/**
 * dsh-voice-mimo — shared TTS logic tests: voice resolution (preset /
 * voicedesign / voiceclone semantics shared with voice_speak) and the
 * node-fetch MiMo speak transport (mock fetch injected).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTtsTarget, speakMiMo, PRESET_VOICES, DEFAULT_READ_ALOUD_VOICE, DEFAULT_STYLE, applyStyle, truncateTtsText } from "../lib/tts.js";

const VOICE_MAP = {
  alloy: { type: "preset", voice: "冰糖" },
  echo: { type: "preset", voice: "苏打", model: "mimo-v2.5-tts-voiceclone" },
  fable: { type: "voicedesign", voice: "温柔的女声" },
  nova: { type: "preset", voice: "mimo_default", model: "mimo-v2.5-tts" },
  raw: { type: "preset", voice: "低沉男声" }, // not a preset → voicedesign fallback
};

test("PRESET_VOICES contains the documented presets", () => {
  for (const v of ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"]) {
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

// ── style/sing mixed mechanism + truncation (spec #6 / issue #7) ──

test("applyStyle: preset voice → style rides the user message (natural language)", () => {
  const out = applyStyle({ style: "用轻快上扬的语调向领导报喜", sing: false, voiceType: "preset", userContent: "Speak the following text naturally.", text: "任务完成" });
  assert.equal(out.userContent, "用轻快上扬的语调向领导报喜");
  assert.equal(out.text, "任务完成");
});

test("applyStyle: preset without style keeps the default userContent", () => {
  const out = applyStyle({ style: "", sing: false, voiceType: "preset", userContent: "Speak the following text naturally.", text: "hi" });
  assert.equal(out.userContent, "Speak the following text naturally.");
  assert.equal(out.text, "hi");
});

test("applyStyle: voicedesign → inline (style) tag prefix, user message untouched", () => {
  const out = applyStyle({ style: "温柔", sing: false, voiceType: "voicedesign", userContent: "温柔治愈系女声", text: "晚安" });
  assert.equal(out.userContent, "温柔治愈系女声");
  assert.equal(out.text, "(温柔)晚安");
});

test("applyStyle: voiceclone keeps the clone instruction and appends the style", () => {
  const out = applyStyle({ style: "低沉", sing: false, voiceType: "voiceclone", userContent: "Use this reference voice to speak the following text naturally.", text: "hi" });
  assert.equal(out.userContent, "Use this reference voice to speak the following text naturally. 低沉");
  assert.equal(out.text, "hi");
});

test("applyStyle: sing → bare (唱歌) prefix; style is NOT applied when singing", () => {
  const s1 = applyStyle({ style: "", sing: true, voiceType: "preset", userContent: "u", text: "原谅我这一生不羁放纵爱自由" });
  assert.equal(s1.text, "(唱歌)原谅我这一生不羁放纵爱自由");
  const s2 = applyStyle({ style: "温柔", sing: true, voiceType: "preset", userContent: "u", text: "小星星" });
  assert.equal(s2.text, "(唱歌)小星星"); // combined (唱歌 温柔) was verified to read, not sing
  assert.equal(s2.userContent, "u"); // style not routed anywhere
});

test("applyStyle: sing with a non-preset voice throws (singing is preset-only)", () => {
  assert.throws(() => applyStyle({ style: "", sing: true, voiceType: "voicedesign", userContent: "u", text: "t" }), /singing requires a preset voice/);
  assert.throws(() => applyStyle({ style: "", sing: true, voiceType: "voiceclone", userContent: "u", text: "t" }), /singing requires a preset voice/);
});

test("truncateTtsText: short text passes through, long text cut at 2500", () => {
  assert.deepEqual(truncateTtsText("hi"), { text: "hi", truncated: false });
  assert.deepEqual(truncateTtsText(""), { text: "", truncated: false });
  const long = "字".repeat(3000);
  const out = truncateTtsText(long);
  assert.equal(out.truncated, true);
  assert.equal(out.text.length, 2500);
  // codepoint-safe: emoji (surrogate pairs) never split
  const emoji = "a".repeat(2499) + "😀";
  const em = truncateTtsText(emoji + "b");
  assert.equal(Array.from(em.text).length, 2500); // codepoint-counted limit
  assert.equal(em.text.endsWith("😀"), true); // surrogate pair never split
});

test("PRESET_VOICES: Dean is the official voice (Dea typo fixed)", () => {
  assert.ok(PRESET_VOICES.has("Dean"));
  assert.ok(!PRESET_VOICES.has("Dea"));
});

test("resolveTtsTarget: exposes voiceType for the style channel", () => {
  assert.equal(resolveTtsTarget({ model: "mimo-v2.5-tts" }, VOICE_MAP, "alloy").voiceType, "preset");
  assert.equal(resolveTtsTarget({}, VOICE_MAP, "fable").voiceType, "voicedesign");
  assert.equal(resolveTtsTarget({}, VOICE_MAP, "echo").voiceType, "voiceclone");
});

test("DEFAULT_STYLE is 温柔", () => {
  assert.equal(DEFAULT_STYLE, "温柔");
});

test("truncation happens AFTER tag prefixing: tags survive, tail is cut (review fix)", () => {
  const applied = applyStyle({ style: "温柔", sing: true, voiceType: "preset", userContent: "u", text: "词".repeat(2499) });
  // (唱歌) is 4 codepoints + 2499 = 2503 > 2500 → truncated, prefix intact
  const out = truncateTtsText(applied.text);
  assert.equal(out.truncated, true);
  assert.ok(out.text.startsWith("(唱歌)"));
  assert.equal(Array.from(out.text).length, 2500);
});
