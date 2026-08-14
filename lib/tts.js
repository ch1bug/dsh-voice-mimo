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
export const PRESET_VOICES = new Set(["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dea"]);

/** Default voice name used by 🔊 read-aloud when Settings tts.voice is empty. */
export const DEFAULT_READ_ALOUD_VOICE = "alloy";

/**
 * Resolve a voice name against the voiceMap into a concrete MiMo TTS target:
 *   { model, userContent, audio, referencePath, needsReference }
 *
 * Mirrors the voice_speak tool semantics exactly (preset → mimo-v2.5-tts with
 * audio.voice; voicedesign → -voicedesign with optimize_text_preview;
 * voiceclone → -voiceclone, requires a reference audio path).
 */
export function resolveTtsTarget(ttsCfg, voiceMap, voiceName) {
  const cfg = ttsCfg ?? {};
  const mapped = voiceMap?.[voiceName];
  const mappedModel = mapped?.model || "";
  if (mappedModel.includes("voiceclone")) {
    return {
      model: mappedModel,
      userContent: "Use this reference voice to speak the following text naturally.",
      audio: { format: "wav" },
      referencePath: null,
      needsReference: true,
    };
  }
  if (mapped !== undefined && mapped.type === "voicedesign") {
    return {
      model: mapped.model || "mimo-v2.5-tts-voicedesign",
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
      userContent: preset,
      audio: { format: "wav", optimize_text_preview: true },
      referencePath: null,
      needsReference: false,
    };
  }
  return {
    model: mapped?.model || cfg.model || "mimo-v2.5-tts",
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
export async function speakMiMo({ baseUrl, apiKey, target, text, format = "wav", timeoutMs = 60000, fetchImpl }) {
  const url = (baseUrl || "https://api.xiaomimimo.com/v1").replace(/\/+$/, "") + "/chat/completions";
  const audio = { ...(target.audio ?? {}), format: format || "wav" };
  const payload = {
    model: target.model,
    messages: [
      { role: "user", content: target.userContent },
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
