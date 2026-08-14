/**
 * dsh-voice — give text-only DeepSeek models ears and a mouth.
 *
 * Three layers:
 *
 *  1. Browser-native voice UI (lib/client.js): a 🎤 mic button records audio
 *     and sends it to the host's `/dsh-voice/stt` route for Whisper
 *     transcription (works even where the browser's cloud SpeechRecognition —
 *     which depends on Google — is unreachable), and a 🔊 read-aloud button
 *     uses the Web Speech API speechSynthesis.
 *  2. Agent tools (this file): `voice_transcribe` (audio file → text) and
 *     `voice_speak` (text → audio file), both via OpenAI-compatible endpoints.
 *  3. An HTTP route `/dsh-voice/stt` registered on the dsh `webServer`,
 *     used by the browser mic for cloud-independent speech recognition.
 *
 * The model never sees or produces raw audio — speech is handled at the
 * input/output boundary, exactly like dsh-vision-bridge converts images to
 * text before the model sees them.
 */

import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const name = "dsh-voice";
const inject = ["tools", "settings", "webServer"];

const Config = z.object({
  /** Speech-to-text backend (mic route + `voice_transcribe` tool). */
  stt: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * OpenAI-compatible `/audio/transcriptions` base URL. In mainland China
       * this is what actually makes the mic work — point it at SiliconFlow
       * (`https://api.siliconflow.cn/v1`), Groq, or a local keyless whisper.cpp
       * server (`http://127.0.0.1:8080/v1`).
       */
      apiBase: z.string().default(""),
      apiKey: z.string().role("secret").default(""),
      apiKeyEnv: z.string().role("credential-ref").default("VOICE_STT_API_KEY"),
      model: z.string().default("whisper-1"),
      /** ISO-639-1 hint (zh / en / …); empty = auto-detect. */
      language: z.string().default(""),
      timeoutMs: z.number().min(1).default(120000),
    })
    .default({}),
  /** Text-to-speech backend for the `voice_speak` tool. */
  tts: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * OpenAI-compatible `/audio/speech` base URL (OpenAI, Azure, or a local
       * keyless service such as a Kokoro/piper HTTP wrapper).
       */
      apiBase: z.string().default(""),
      apiKey: z.string().role("secret").default(""),
      apiKeyEnv: z.string().role("credential-ref").default("VOICE_TTS_API_KEY"),
      model: z.string().default("tts-1"),
      voice: z.string().default("alloy"),
      format: z.string().default("mp3"),
      timeoutMs: z.number().min(1).default(60000),
    })
    .default({}),
});

const VOICE_NS = settingsNamespace("voice");

/** Resolve an API key from direct config, then from the configured env var. */
function resolveKey(cfg) {
  if (cfg.apiKey) return cfg.apiKey;
  if (cfg.apiKeyEnv && process.env[cfg.apiKeyEnv]) return process.env[cfg.apiKeyEnv];
  return "";
}

/** True when the STT backend has not been configured at all. */
function sttUnconfigured(cfg) {
  return !cfg.apiBase && !resolveKey(cfg);
}

/**
 * Send raw audio bytes to the Whisper-compatible `/audio/transcriptions`
 * endpoint and return `{ text, language }`.
 */
async function transcribeAudio(cfg, audioBytes, languageHint) {
  if (sttUnconfigured(cfg)) {
    const err = new Error(
      "STT backend not configured. Set voice.stt.apiBase in settings.yaml (e.g. SiliconFlow https://api.siliconflow.cn/v1, or a local whisper.cpp server http://127.0.0.1:8080/v1).",
    );
    err.code = "NOT_CONFIGURED";
    throw err;
  }
  const apiBase = (cfg.apiBase || "https://api.openai.com/v1").replace(/\/+$/, "");
  const apiKey = resolveKey(cfg);
  const form = new FormData();
  form.append("file", new Blob([audioBytes], { type: "audio/webm" }), "audio.webm");
  form.append("model", cfg.model);
  const lang = languageHint || cfg.language;
  if (lang) form.append("language", lang);
  const res = await fetch(`${apiBase}/audio/transcriptions`, {
    method: "POST",
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    body: form,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`transcription upstream ${res.status}: ${detail.slice(0, 500)}`);
  }
  const data = await res.json();
  return {
    text: typeof data.text === "string" ? data.text : JSON.stringify(data),
    language: data.language,
  };
}

/** Read the whole request body of a node:http IncomingMessage. */
async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function apply(ctx, config) {
  let current = () => config;
  installSettingsSection(ctx, VOICE_NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {},
  });

  const logger = ctx.logger;

  // ────────────────────────────────────────────────────────────────────────────
  // HTTP route: /dsh-voice/stt  (browser mic → host → Whisper)
  // ────────────────────────────────────────────────────────────────────────────
  ctx.webServer.register({
    kind: "exact",
    path: "/dsh-voice/stt",
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        const audio = await readRequestBody(req);
        if (!audio.length) {
          sendJson(res, 400, { error: "empty audio body" });
          return;
        }
        const result = await transcribeAudio(current().stt, audio, "");
        sendJson(res, 200, result);
      } catch (err) {
        const status = err && err.code === "NOT_CONFIGURED" ? 400 : 500;
        sendJson(res, status, { error: err && err.message ? err.message : String(err) });
      }
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // voice_transcribe — audio file → text
  // ────────────────────────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: "voice_transcribe",
      description:
        "Transcribe an audio file (wav/mp3/m4a/ogg/webm/flac) to text via a Whisper-compatible /audio/transcriptions endpoint. Lets a text-only model 'hear' recordings the user attaches.",
      parameters: {
        path: {
          type: "string",
          required: true,
          description: "Absolute path to the audio file to transcribe.",
        },
        language: {
          type: "string",
          description: "Optional language hint (ISO-639-1, e.g. zh, en). Leave empty to auto-detect.",
        },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            text: { type: "string", required: true, description: "Transcribed text." },
            language: { type: "string", description: "Detected / used language." },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        const bytes = await readFile(resolve(args.path));
        return transcribeAudio(current().stt, bytes, args.language);
      },
    }),
  );

  // ────────────────────────────────────────────────────────────────────────────
  // voice_speak — text → audio file
  // ────────────────────────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: "voice_speak",
      description:
        "Generate a spoken audio file from text via an OpenAI-compatible /audio/speech endpoint. Writes the audio to the workspace and returns its path. To read a reply aloud directly in the Web UI, use the 🔊 button on the message instead.",
      parameters: {
        text: {
          type: "string",
          required: true,
          description: "Text to synthesize into speech.",
        },
        outPath: {
          type: "string",
          description: "Optional absolute output path (default: <cwd>/dsh-voice-<timestamp>.<format>).",
        },
        voice: {
          type: "string",
          description: "Optional voice override.",
        },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            path: { type: "string", required: true, description: "Absolute path to the written audio file." },
            bytes: { type: "integer", required: true, description: "Bytes written." },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          { type: "text", text: `Generated speech: ${value.path} (${value.bytes} bytes)` },
        ],
      },
      async execute(args) {
        const cfg = current().tts;
        const apiBase = (cfg.apiBase || "https://api.openai.com/v1").replace(/\/+$/, "");
        const apiKey = resolveKey(cfg);
        if (!apiKey) {
          throw new Error(
            "voice_speak needs an API key: set voice.tts.apiKey (or VOICE_TTS_API_KEY), or point voice.tts.apiBase at a keyless local TTS service.",
          );
        }
        const res = await fetch(`${apiBase}/audio/speech`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: cfg.model,
            input: args.text,
            voice: args.voice || cfg.voice,
            response_format: cfg.format,
          }),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (!res.ok) {
          throw new Error(`voice_speak failed: ${res.status} ${await res.text()}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const out = args.outPath
          ? resolve(args.outPath)
          : resolve(process.cwd(), `dsh-voice-${Date.now()}.${cfg.format}`);
        await writeFile(out, buf);
        return { path: out, bytes: buf.length };
      },
    }),
  );

  logger?.info?.("[dsh-voice] registered /dsh-voice/stt + voice_transcribe + voice_speak");
}

export { Config, apply, inject, name };
