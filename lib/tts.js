/**
 * dsh-voice-mimo — shared MiMo TTS logic (single source of truth).
 *
 * Two callers share this module:
 *   - the `voice_speak` agent tool (lib/index.js) — shell/python transport
 *     (64KB stdout cap: base64 must never cross stdout), and
 *   - the host 🔊 read-aloud route `POST /_dsh/voice-mimo/speak`
 *     (lib/web.js) — node fetch transport (no stdout cap).
 *
 * `resolveTtsTarget` decides the model + message/audio shape from a voice
 * name against the Settings voiceMap (preset / voicedesign / voiceclone
 * semantics). `speakMiMo` is the node-fetch transport used by the host
 * route; `fetchImpl` is injectable for tests.
 */

/** MiMo TTS preset voices (mimo-v2.5-tts accepts these directly). */
export const PRESET_VOICES = new Set(["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"]);

/** Default voice name used by 🔊 read-aloud when Settings tts.voice is empty. */
export const DEFAULT_READ_ALOUD_VOICE = "alloy";

/** Default read-aloud / voice_speak style when Settings tts.style is empty. */
export const DEFAULT_STYLE = "温柔";

/** Official guidance: segment TTS text beyond this many characters. */
export const MAX_TTS_TEXT_CHARS = 2500;

/**
 * Truncate TTS target text to MAX_TTS_TEXT_CHARS (codepoint-safe). Returns
 * { text, truncated } — a silent over-limit request would fail at the API,
 * so we cut explicitly and let the caller surface the flag.
 */
export function truncateTtsText(text) {
  const t = String(text ?? "");
  if (t.length <= MAX_TTS_TEXT_CHARS) return { text: t, truncated: false };
  return { text: Array.from(t).slice(0, MAX_TTS_TEXT_CHARS).join(""), truncated: true };
}

/**
 * Resolve the effective style: explicit (tool/request) value wins, else the
 * Settings tts.style (朗读语气), else the shared default. Shared by the
 * voice_speak tool and the 🔊 read-aloud route so both resolve identically.
 */
export function resolveStyle(ttsCfg, explicitStyle) {
  const s = typeof explicitStyle === "string" ? explicitStyle.trim() : "";
  if (s) return s;
  const cfg = ttsCfg ?? {};
  return (typeof cfg.style === "string" && cfg.style.trim()) ? cfg.style.trim() : DEFAULT_STYLE;
}

/**
 * Apply the style/sing decisions to one TTS request (spec #6 — mixed channel):
 *
 * - preset / voiceclone → the style rides the USER message as a natural-language
 *   instruction (full expression incl. director mode). No style → the caller's
 *   default userContent stands.
 * - voicedesign → the user message is owned by the voice description, so the
 *   style moves to an inline tag prefix `(style)` on the assistant text.
 * - sing → a bare `(唱歌)` prefix on the assistant text (the style is NOT
 *   routed anywhere when singing — a combined `(唱歌 style)` bracket was
 *   verified to drift into reading). Singing is preset-only.
 *
 * Returns { userContent, text }.
 */
export function applyStyle({ style, sing, voiceType, userContent, text }) {
  const s = typeof style === "string" ? style.trim() : "";
  const wantsSing = sing === true;
  let nextUser = userContent;
  let nextText = String(text ?? "");
  if (wantsSing) {
    if (voiceType !== "preset") {
      throw new Error(`singing requires a preset voice (mimo-v2.5-tts); the resolved voice type is ${voiceType}`);
    }
    // Bare (唱歌) at the very start — per the official docs AND verified by
    // real synthesis: a combined bracket like (唱歌 温柔) drifts the model
    // into "speak gently" and reads instead of sings. Style is not routed
    // anywhere when singing.
    nextText = `(唱歌)${nextText}`;
  } else if (s) {
    if (voiceType === "voicedesign") {
      nextText = `(${s})${nextText}`;
    } else if (voiceType === "voiceclone") {
      // Keep the clone instruction (use the reference voice) and append the
      // style — replacing it would drop the clone directive.
      nextUser = nextUser ? `${nextUser} ${s}` : s;
    } else {
      // preset: the style instruction IS the user message.
      nextUser = s;
    }
  }
  return { userContent: nextUser, text: nextText };
}

/**
 * Resolve a voice name against the voiceMap into a concrete MiMo TTS target:
 *   { model, voiceType, userContent, audio, referencePath, needsReference }
 *
 * voiceType ∈ preset | voicedesign | voiceclone — the style-channel decision
 * (applyStyle) keys off it. Mirrors the voice_speak tool semantics exactly
 * (preset → mimo-v2.5-tts with audio.voice; voicedesign → -voicedesign with
 * optimize_text_preview; voiceclone → -voiceclone, needs a reference audio).
 */
export function resolveTtsTarget(ttsCfg, voiceMap, voiceName) {
  const cfg = ttsCfg ?? {};
  const mapped = voiceMap?.[voiceName];
  const mappedModel = mapped?.model || "";
  if (mappedModel.includes("voiceclone")) {
    return {
      model: mappedModel,
      voiceType: "voiceclone",
      userContent: "Use this reference voice to speak the following text naturally.",
      audio: { format: "wav" },
      referencePath: null,
      needsReference: true,
    };
  }
  if (mapped !== undefined && mapped.type === "voicedesign") {
    return {
      model: mapped.model || "mimo-v2.5-tts-voicedesign",
      voiceType: "voicedesign",
      userContent: mapped.voice,
      audio: { format: "wav", optimize_text_preview: true },
      referencePath: null,
      needsReference: false,
    };
  }
  const preset = mapped !== undefined ? mapped.voice : (PRESET_VOICES.has(voiceName) ? voiceName : "mimo_default");
  if (!PRESET_VOICES.has(preset)) {
    // Not a preset — treat as a voicedesign description.
    return {
      model: mapped?.model || "mimo-v2.5-tts-voicedesign",
      voiceType: "voicedesign",
      userContent: preset,
      audio: { format: "wav", optimize_text_preview: true },
      referencePath: null,
      needsReference: false,
    };
  }
  return {
    model: mapped?.model || cfg.model || "mimo-v2.5-tts",
    voiceType: "preset",
    userContent: "Speak the following text naturally.",
    audio: { format: "wav", voice: preset },
    referencePath: null,
    needsReference: false,
  };
}

/**
 * Synthesize `text` via MiMo TTS using node fetch (host routes only — no
 * 64KB shell stdout cap, so base64 audio may ride in the JSON response).
 *
 * Returns { bytes: Buffer, mime } of the decoded audio. Throws on HTTP or
 * response-shape errors. `fetchImpl` defaults to global fetch (inject for
 * tests).
 */
export async function speakMiMo({ baseUrl, apiKey, target, text, userContent, format = "wav", timeoutMs = 60000, fetchImpl }) {
  const url = (baseUrl || "https://api.xiaomimimo.com/v1").replace(/\/+$/, "") + "/chat/completions";
  const audio = { ...(target.audio ?? {}), format: format || "wav" };
  const payload = {
    model: target.model,
    messages: [
      { role: "user", content: userContent ?? target.userContent },
      { role: "assistant", content: text },
    ],
    audio,
  };
  const doFetch = fetchImpl ?? globalThis.fetch;
  let response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs || 60000),
    });
  } catch (error) {
    throw new Error(`MiMo TTS request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`MiMo TTS HTTP ${response.status}: ${text.slice(0, 400)}`);
  }
  const data = await response.json();
  const base64 = data?.choices?.[0]?.message?.audio?.data;
  if (typeof base64 !== "string" || base64.length === 0) {
    throw new Error("MiMo TTS returned no audio data");
  }
  return { bytes: Buffer.from(base64, "base64"), mime: "audio/wav" };
}
