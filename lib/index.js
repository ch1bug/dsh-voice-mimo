/**
 * dsh-voice-mimo — voice for DeepSeek Harness backed by Xiaomi MiMo.
 *
 * Fork of zhuiyueya/dsh-voice (MIT) — the browser voice UI (lib/client.js)
 * is inherited as-is: a 🎤 mic button in the composer (Web Speech API
 * SpeechRecognition → transcribed text lands in the input) and a 🔊
 * read-aloud button on every assistant message (speechSynthesis). Zero API
 * key, works out of the box.
 *
 * The agent tools are rewired from OpenAI-compatible endpoints to the MiMo
 * API directly, because MiMo exposes no /audio/transcriptions or
 * /audio/speech endpoints — its ASR/TTS live on chat/completions with a
 * private message/audio shape:
 *
 *   - voice_transcribe: audio file → base64 → MiMo ASR (mimo-v2.5-asr) → text
 *   - voice_speak:      text → MiMo TTS (mimo-v2.5-tts / -voicedesign) → .wav
 *
 * The voice map (OpenAI voice names like alloy/echo → MiMo preset or voice
 * design description) is user-configurable through the DSH Settings page,
 * which follows the Anionex/dsh-vision-toolkit (MIT) settings pattern.
 *
 * Configuration: plugin config (patch layer) plus the `voice` settings
 * namespace (settings.yaml / Settings page, hot-reloaded via applies:'live').
 */

import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { resolveTtsTarget } from "./tts.js";
import {
  cleanTmp,
  initAudioStore,
  manifestAppend,
  newAudioId,
  planSpeechArtifact,
  resolveAudioDir,
  wavDurationSeconds,
  wslPathOf,
} from "./audio-store.js";

const name = "dsh-voice-mimo";
const inject = ["tools", "settings", "shell", "sandboxPolicy", "credentials"];

const VOICE_NS = settingsNamespace("voice-mimo");

/** Default OpenAI voice name → MiMo mapping, editable in Settings. */
const DEFAULT_VOICE_MAP = {
  alloy: { type: "preset", voice: "冰糖" },
  echo: { type: "preset", voice: "苏打" },
  fable: { type: "preset", voice: "茉莉" },
  onyx: { type: "preset", voice: "白桦" },
  nova: { type: "preset", voice: "Mia" },
  shimmer: { type: "preset", voice: "mimo_default" },
};

const voiceMapSchema = z.dict(
  z.object({
    type: z.union([z.const("preset"), z.const("voicedesign")]).required(),
    /** MiMo preset ID when type=preset; free-form Chinese voice description when type=voicedesign. */
    voice: z.string().required(),
    /**
     * Optional model override. Empty = inferred from type
     * (preset → mimo-v2.5-tts, voicedesign → mimo-v2.5-tts-voicedesign).
     * Set it to route this voice through a different model (e.g.
     * mimo-v2.5-tts-voiceclone for a cloned timbre).
     */
    model: z.string().default(""),
  }),
);

const Config = z.object({
  /** MiMo provider: base URL and DSH Credential reference. */
  provider: z
    .object({
      baseUrl: z.string().default("https://api.xiaomimimo.com/v1"),
      credential: z.string().default("XIAOMI_API_KEY"),
    })
    .default({}),
  /** Voice map: OpenAI voice name → MiMo preset or voice design. */
  voiceMap: voiceMapSchema.default(DEFAULT_VOICE_MAP),
  /** Audio output storage: layered tmp/ + long/ under audioDir. */
  audio: z
    .object({
      /** Root of the audio subtree. Empty = ~/.dsh/cache/voice-mimo. */
      dir: z.string().default(""),
      /** Inline-vs-card threshold (seconds) for agent speech (#3). */
      inlineThreshold: z.number().min(1).default(30),
      /** Loose long-term retention fallback (#5). */
      longRetainCount: z.number().min(1).default(200),
      longRetainDays: z.number().min(1).default(30),
    })
    .default({}),
  /** Speech-to-text backend settings for `voice_transcribe`. */
  stt: z
    .object({
      enabled: z.boolean().default(true),
      model: z.string().default("mimo-v2.5-asr"),
      language: z.string().default(""),
      timeoutMs: z.number().min(1).default(120000),
    })
    .default({}),
  /** Text-to-speech backend settings for `voice_speak`. */
  tts: z
    .object({
      enabled: z.boolean().default(true),
      model: z.string().default("mimo-v2.5-tts"),
      format: z.string().default("wav"),
      timeoutMs: z.number().min(1).default(60000),
      /** Read-aloud voice: a voiceMap key used by the 🔊 button (default alloy→冰糖). */
      voice: z.string().default("alloy"),
    })
    .default({}),
});

/** Resolve the MiMo API key from DSH Credentials. */
async function resolveMimoKey(ctx) {
  const credentials = ctx.get("credentials");
  if (credentials === undefined) throw new Error("credentials service is unavailable");
  const provider = currentConfig?.provider ?? {};
  const ref = provider.credential || "XIAOMI_API_KEY";
  const resolved = await credentials.resolve(ref);
  if (resolved === undefined) {
    throw new Error(`voice-mimo: credential ${ref} is not configured; store it through DSH Credentials (web Models page)`);
  }
  return resolved.value;
}

let currentConfig = {};

/**
 * Run one shell command through the DSH shell service, with sandbox policy
 * resolution and the 64KB stdout cap in mind. Large payloads must be moved
 * through files (see the MiMo tools below), never through stdout.
 */
async function run(ctx, command, exec, opts = {}) {
  const shell = ctx.get("shell");
  if (shell === undefined) throw new Error("shell service is unavailable");
  const sandboxPolicy = ctx.get("sandboxPolicy");
  const policy = sandboxPolicy === undefined ? undefined : sandboxPolicy.resolve(
    exec !== undefined && exec.agent !== undefined ? { session: exec.agent.session } : {},
  );
  const request = {
    command,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
    ...(exec !== undefined && exec.signal !== undefined ? { signal: exec.signal } : {}),
  };
  return shell.run(request);
}

/** UTF-8-safe base64: Node's btoa() rejects non-Latin-1 (Chinese would throw). */
function b64(s) {
  const bytes = new TextEncoder().encode(String(s));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// wslPathOf lives in ./audio-store.js (single source of truth).


async function apply(ctx, config) {
  // Default-fill the config by hand (schemastery z.object has no .parse);
  // the settings namespace later replaces this with its live source.
  const raw = config ?? {};
  const provider = raw.provider ?? {};
  const audio = raw.audio ?? {};
  const stt = raw.stt ?? {};
  const tts = raw.tts ?? {};
  const safeConfig = {
    provider: {
      baseUrl: provider.baseUrl || "https://api.xiaomimimo.com/v1",
      credential: provider.credential || "XIAOMI_API_KEY",
    },
    voiceMap: raw.voiceMap ?? DEFAULT_VOICE_MAP,
    audio: {
      dir: audio.dir ?? "",
      inlineThreshold: audio.inlineThreshold ?? 30,
      longRetainCount: audio.longRetainCount ?? 200,
      longRetainDays: audio.longRetainDays ?? 30,
    },
    stt: {
      enabled: stt.enabled ?? true,
      model: stt.model || "mimo-v2.5-asr",
      language: stt.language ?? "",
      timeoutMs: stt.timeoutMs ?? 120000,
    },
    tts: {
      enabled: tts.enabled ?? true,
      model: tts.model || "mimo-v2.5-tts",
      format: tts.format ?? "wav",
      timeoutMs: tts.timeoutMs ?? 60000,
      voice: tts.voice || "alloy",
    },
  };
  currentConfig = safeConfig;
  let current = () => currentConfig;
  installSettingsSection(ctx, VOICE_NS, Config, safeConfig, {
    setSource: (source) => {
      current = source;
      currentConfig = source();
    },
    onChange: () => {},
  });

  // Audio storage skeleton: create tmp/ + long/ under audioDir and clear the
  // previous process's tmp/ leftovers (idempotent — spec #1, issue #2).
  try {
    const audioDir = resolveAudioDir(current().audio, resolveDshHome());
    await initAudioStore(audioDir);
    await cleanTmp(audioDir);
    ctx.logger?.info?.(`[dsh-voice-mimo] audioDir ready at ${audioDir} (tmp cleaned)`);
  } catch (error) {
    ctx.logger?.warn?.(
      `[dsh-voice-mimo] audioDir init failed: ${error instanceof Error ? error.message : String(error)} — 🔊 read-aloud will retry per request`,
    );
  }

  const logger = ctx.logger;

  // Settings snapshot for the Web Settings page (vision-toolkit pattern).
  // The revision comes from settings.describe() — the real storage revision,
  // not a local counter — so optimistic locking matches the persisted state.
  const getSettings = () => {
    const settings = ctx.get("settings");
    const descriptor = settings?.describe?.().find((row) => row.ns === VOICE_NS);
    return {
      value: current(),
      revision: descriptor?.revision ?? 0,
      writable: settings?.writable ?? false,
    };
  };
  const updateSettings = async (value, expectedRevision) => {
    try {
      const settings = ctx.get("settings");
      if (settings === undefined) return { ok: false, message: "settings service unavailable" };
      // replace() validates against the registered Config schema and refuses
      // stale writes via expectedRevision.
      await settings.replace(VOICE_NS, value ?? {}, expectedRevision);
      return { ok: true, revision: expectedRevision };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };

  // ────────────────────────────────────────────────────────────────────────────
  // voice_transcribe — audio file → text (MiMo ASR, chat/completions)
  // ────────────────────────────────────────────────────────────────────────────
  if (current().stt.enabled) ctx.tools.register(
    defineTool({
      name: "voice_transcribe",
      description:
        "Transcribe an audio file (wav/mp3/m4a/ogg/flac) to text using the Xiaomi MiMo ASR model. Lets a text-only model 'hear' recordings the user attaches.",
      parameters: {
        path: {
          type: "string",
          required: true,
          description: "Absolute path to the audio file to transcribe (WSL or Windows path).",
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
      async execute(args, exec) {
        const cfg = current().stt;
        const provider = current().provider;
        const baseUrl = (provider.baseUrl || "https://api.xiaomimimo.com/v1").replace(/\/+$/, "");
        const apiKey = await resolveMimoKey(ctx);
        const wsl = wslPathOf(args.path);
        // One python pass: read the audio file, base64 it, build the MiMo ASR
        // request, POST, and write the raw response to disk. The base64 audio
        // (~MBs) must never cross the 64KB shell stdout cap.
        const tmp = `/tmp/voice_mimo_asr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const py = b64([
          "import sys,json,base64,urllib.request,urllib.error",
          "src,lang,api,url,out = sys.argv[1:6]",
          "b=open(src,'rb').read()",
          "durl='data:audio/wav;base64,'+base64.b64encode(b).decode()",
          "payload={'model':'mimo-v2.5-asr','messages':[{'role':'user','content':[{'type':'input_audio','input_audio':{'data':durl}}]}],'stream':False}",
          "if lang: payload['asr_options']={'language':lang}",
          "req=urllib.request.Request(url,data=json.dumps(payload).encode(),headers={'api-key':api,'Content-Type':'application/json'})",
          "try:",
          "  r=urllib.request.urlopen(req,timeout=150)",
          "  open(out,'wb').write(r.read())",
          "  print('OK')",
          "except urllib.error.HTTPError as e:",
          "  open(out,'w').write(e.read().decode('utf-8','replace')[:500])",
          "  print('HTTP_ERR')",
          "except Exception as ex:",
          "  open(out,'w').write('NET_ERR:'+str(ex)[:300])",
          "  print('NET_ERR')",
        ].join("\n"));
        const pyCmd = `printf '%s' ${py} | base64 -d | python3 - ${shq(wsl)} ${shq(args.language || "")} ${shq(apiKey)} ${shq(baseUrl + "/chat/completions")} ${shq(tmp + ".resp")}`;
        const r = await run(ctx, pyCmd, exec, { timeoutMs: cfg.timeoutMs || 150000 });
        const status = r.stdout.text.trim();
        if (!status.startsWith("OK")) {
          let errText = "";
          try { errText = (await run(ctx, `cat ${shq(tmp + ".resp")}`, exec, { timeoutMs: 5000 })).stdout.text.trim() || ""; } catch {}
          await run(ctx, `rm -f ${shq(tmp + ".resp")}`, exec, { timeoutMs: 5000 }).catch(() => {});
          throw new Error(`voice_transcribe failed: ${errText || status}`);
        }
        // Read the response through python (not cat) — the response JSON may
        // exceed the 64KB stdout cap.
        const extractPy = b64([
          "import sys,json",
          "try:",
          "  d=json.load(open(sys.argv[1],'rb'))",
          "  c=d['choices'][0]['message']['content']",
          "  print(c if isinstance(c,str) else json.dumps(c,ensure_ascii=False))",
          "except Exception as ex:",
          "  print('ERR:'+str(ex)[:300])",
        ].join("\n"));
        const extRun = await run(ctx, `printf '%s' ${extractPy} | base64 -d | python3 - ${shq(tmp + ".resp")}`, exec, { timeoutMs: 10000 });
        await run(ctx, `rm -f ${shq(tmp + ".resp")}`, exec, { timeoutMs: 5000 }).catch(() => {});
        const text = extRun.stdout.text.trim();
        if (text.startsWith("ERR:")) throw new Error(`voice_transcribe: ${text.slice(4)}`);
        // Only include language when provided — `undefined` is not lossless
        // JSON and the tool output validator rejects it.
        const result = { text };
        if (args.language) result.language = args.language;
        return result;
      },
    }),
  );

  // ────────────────────────────────────────────────────────────────────────────
  // voice_understand — audio file → semantic understanding (MiMo-v2.5)
  // ────────────────────────────────────────────────────────────────────────────
  if (current().stt.enabled) ctx.tools.register(
    defineTool({
      name: "voice_understand",
      description:
        "Understand the content of an audio file (wav/mp3/m4a/ogg/flac) with the Xiaomi MiMo multimodal model: summarize what was said, extract information, identify speakers/emotion, or answer questions about the audio. Unlike voice_transcribe (verbatim transcript), this returns a semantic analysis. Use this when the user wants to know what an audio is ABOUT, not its exact wording.",
      parameters: {
        path: {
          type: "string",
          required: true,
          description: "Absolute path to the audio file (WSL or Windows path).",
        },
        prompt: {
          type: "string",
          description: "What to find out about the audio (e.g. '总结要点', '这是什么情绪', '提取人名'). Default: a detailed summary.",
        },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            text: { type: "string", required: true, description: "The semantic analysis result." },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        const cfg = current().stt;
        const provider = current().provider;
        const baseUrl = (provider.baseUrl || "https://api.xiaomimimo.com/v1").replace(/\/+$/, "");
        const apiKey = await resolveMimoKey(ctx);
        const wsl = wslPathOf(args.path);
        const prompt = args.prompt || "Listen to this audio and provide a detailed summary of its content, main points, and any notable details.";
        const tmp = `/tmp/voice_mimo_und_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const system = "You are MiMo, an AI assistant developed by Xiaomi. When the user provides an audio part, listen to it and answer about its content.";
        const py = b64([
          "import sys,json,base64,urllib.request,urllib.error",
          "src,prompt,api,url,out = sys.argv[1:6]",
          "b=open(src,'rb').read()",
          "durl='data:audio/wav;base64,'+base64.b64encode(b).decode()",
          "payload={'model':'mimo-v2.5','messages':[{'role':'system','content':'" + system.replace(/'/g, "\\'") + "'},{'role':'user','content':[{'type':'input_audio','input_audio':{'data':durl}},{'type':'text','text':prompt}]}],'stream':False,'max_completion_tokens':4096}",
          "def attempt():",
          "  req=urllib.request.Request(url,data=json.dumps(payload).encode(),headers={'api-key':api,'Content-Type':'application/json'})",
          "  r=urllib.request.urlopen(req,timeout=180)",
          "  open(out,'wb').write(r.read())",
          "try:",
          "  attempt()",
          "  print('OK')",
          "except urllib.error.HTTPError as e:",
          "  open(out,'w').write(e.read().decode('utf-8','replace')[:500])",
          "  print('HTTP_ERR')",
          "except Exception as ex:",
          "  # Retry once: MiMo occasionally returns an empty/unusable reply for audio.",
          "  try:",
          "    attempt()",
          "    print('OK')",
          "  except urllib.error.HTTPError as e2:",
          "    open(out,'w').write(e2.read().decode('utf-8','replace')[:500])",
          "    print('HTTP_ERR')",
          "  except Exception as ex2:",
          "    open(out,'w').write('NET_ERR:'+str(ex2)[:300])",
          "    print('NET_ERR')",
        ].join("\n"));
        const pyCmd = `printf '%s' ${py} | base64 -d | python3 - ${shq(wsl)} ${shq(prompt)} ${shq(apiKey)} ${shq(baseUrl + "/chat/completions")} ${shq(tmp + ".resp")}`;
        const r = await run(ctx, pyCmd, exec, { timeoutMs: cfg.timeoutMs || 200000 });
        const status = r.stdout.text.trim();
        if (!status.startsWith("OK")) {
          let errText = "";
          try { errText = (await run(ctx, `cat ${shq(tmp + ".resp")}`, exec, { timeoutMs: 5000 })).stdout.text.trim() || ""; } catch {}
          await run(ctx, `rm -f ${shq(tmp + ".resp")}`, exec, { timeoutMs: 5000 }).catch(() => {});
          throw new Error(`voice_understand failed: ${errText || status}`);
        }
        const extractPy = b64([
          "import sys,json",
          "try:",
          "  d=json.load(open(sys.argv[1],'rb'))",
          "  c=d['choices'][0]['message']['content']",
          "  print(c if isinstance(c,str) else json.dumps(c,ensure_ascii=False))",
          "except Exception as ex:",
          "  print('ERR:'+str(ex)[:300])",
        ].join("\n"));
        const extRun = await run(ctx, `printf '%s' ${extractPy} | base64 -d | python3 - ${shq(tmp + ".resp")}`, exec, { timeoutMs: 10000 });
        await run(ctx, `rm -f ${shq(tmp + ".resp")}`, exec, { timeoutMs: 5000 }).catch(() => {});
        const text = extRun.stdout.text.trim();
        if (text.startsWith("ERR:")) throw new Error(`voice_understand: ${text.slice(4)}`);
        return { text };
      },
    }),
  );

  // ────────────────────────────────────────────────────────────────────────────
  // voice_speak — text → audio file (MiMo TTS, chat/completions)
  // ────────────────────────────────────────────────────────────────────────────
  if (current().tts.enabled) ctx.tools.register(
    defineTool({
      name: "voice_speak",
      description:
        "Generate a spoken audio file from text using the Xiaomi MiMo TTS models. Without an explicit outPath the file lands in the plugin's long-term audio store and a playable/downloadable strip appears in the conversation; with outPath the caller's path is used as-is. To read a reply aloud directly in the Web UI, use the 🔊 button on the message instead.",
      parameters: {
        text: {
          type: "string",
          required: true,
          description: "Text to synthesize into speech.",
        },
        outPath: {
          type: "string",
          description: "Optional output .wav path (Windows or WSL) to write instead of the long-term audio store. When given, the exact path is respected and no playable strip is registered.",
        },
        voice: {
          type: "string",
          description: "Optional voice: an OpenAI voice name from the configured voice map (alloy/echo/fable/onyx/nova/shimmer), a MiMo preset (mimo_default/冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dea), or a free-form Chinese voice description.",
        },
        reference: {
          type: "string",
          description: "Optional reference audio path (local WSL/Windows path or URL) for the voice-clone model (mimo-v2.5-tts-voiceclone). Required when the resolved model is the voice-clone model.",
        },
        notify: {
          type: "boolean",
          description: "Flag this speech as a user notification (auto read-aloud wiring; default false).",
        },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            path: { type: "string", required: true, description: "Absolute path to the written audio file." },
            bytes: { type: "integer", required: true, description: "Bytes written." },
            audioUrl: { type: "string", description: "Same-origin URL to play/download the audio (present when stored in the long-term store)." },
            seconds: { type: "number", description: "Duration of the audio in seconds (when parseable)." },
            notify: { type: "boolean", description: "Whether this speech was flagged as a notification." },
          },
          additionalProperties: false,
        },
        render: (_args, value) => {
          const blocks = [
            { type: "text", text: `Generated speech: ${value.path} (${value.bytes} bytes${value.seconds != null ? `, ${value.seconds}s` : ""})` },
          ];
          // Structured envelope for the client's voice_speak toolview (play
          // strip / card). The client parses this block; the line above keeps
          // the plain-text summary for the model and any fallback UI.
          if (value.audioUrl) {
            blocks.push({
              type: "text",
              text: JSON.stringify({
                path: value.path,
                bytes: value.bytes,
                audioUrl: value.audioUrl,
                seconds: value.seconds,
                notify: value.notify === true,
              }),
            });
          }
          return blocks;
        },
      },
      async execute(args, exec) {
        const cfg = current().tts;
        const provider = current().provider;
        const baseUrl = (provider.baseUrl || "https://api.xiaomimimo.com/v1").replace(/\/+$/, "");
        const apiKey = await resolveMimoKey(ctx);
        // Explicit outPath → the caller's exact path (converted to WSL);
        // otherwise python extracts to a temp file that we move into long/.
        const outWsl = args.outPath ? wslPathOf(args.outPath) : `/tmp/voice_mimo_tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`;

        // Resolve the voice: voice map → MiMo preset / voice design / clone
        // (shared semantics with the 🔊 read-aloud route, lib/tts.js).
        const voiceName = args.voice || "alloy";
        const target = resolveTtsTarget(current().tts, current().voiceMap, voiceName);
        let model = target.model;
        let userContent = target.userContent;
        let audio = target.audio;
        let referencePath = null;
        if (target.needsReference) {
          // Voice-clone model: needs a reference audio file (read inside python
          // so the DataURL never crosses argv or the 64KB stdout cap).
          if (!args.reference) {
            throw new Error(
              "voice_speak: voice " + JSON.stringify(voiceName) + " maps to the voice-clone model, which needs a `reference` audio path (a short clip of the voice to clone).",
            );
          }
          referencePath = /^https?:\/\//i.test(args.reference) ? args.reference : wslPathOf(args.reference);
        }

        // For the voice-clone model, python reads the reference file itself.
        const tmp = `/tmp/voice_mimo_tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const py = b64([
          "import sys,json,base64,urllib.request,urllib.error",
          "model,text,uc,audio,ref,api,url,out = sys.argv[1:9]",
          "a=json.loads(audio)",
          "if ref:",
          "  b=urllib.request.urlopen(ref,timeout=60).read() if ref.startswith(('http://','https://')) else open(ref,'rb').read()",
          "  a['voice']='data:audio/wav;base64,'+base64.b64encode(b).decode()",
          "payload={'model':model,'messages':[{'role':'user','content':uc},{'role':'assistant','content':text}],'audio':a}",
          "req=urllib.request.Request(url,data=json.dumps(payload).encode(),headers={'api-key':api,'Content-Type':'application/json'})",
          "try:",
          "  r=urllib.request.urlopen(req,timeout=180)",
          "  open(out,'wb').write(r.read())",
          "  print('OK')",
          "except urllib.error.HTTPError as e:",
          "  open(out,'w').write(e.read().decode('utf-8','replace')[:500])",
          "  print('HTTP_ERR')",
          "except Exception as ex:",
          "  open(out,'w').write('NET_ERR:'+str(ex)[:300])",
          "  print('NET_ERR')",
        ].join("\n"));
        const pyCmd = `printf '%s' ${py} | base64 -d | python3 - ${shq(model)} ${shq(args.text)} ${shq(userContent)} ${shq(JSON.stringify(audio))} ${shq(referencePath || "")} ${shq(apiKey)} ${shq(baseUrl + "/chat/completions")} ${shq(tmp + ".resp")}`;
        const r = await run(ctx, pyCmd, exec, { timeoutMs: cfg.timeoutMs || 200000 });
        const status = r.stdout.text.trim();
        if (!status.startsWith("OK")) {
          let errText = "";
          try { errText = (await run(ctx, `cat ${shq(tmp + ".resp")}`, exec, { timeoutMs: 5000 })).stdout.text.trim() || ""; } catch {}
          await run(ctx, `rm -f ${shq(tmp + ".resp")}`, exec, { timeoutMs: 5000 }).catch(() => {});
          throw new Error(`voice_speak failed: ${errText || status}`);
        }
        // Extract the base64 audio from the response via python reading the
        // file directly — the audio data can exceed the 64KB stdout cap.
        const extractPy = b64([
          "import sys,json,base64",
          "try:",
          "  d=json.load(open(sys.argv[1],'rb'))",
          "  b=d['choices'][0]['message']['audio']['data']",
          "  open(sys.argv[2],'wb').write(base64.b64decode(b))",
          "  print('OK')",
          "except Exception as ex:",
          "  print('ERR:'+str(ex)[:300])",
        ].join("\n"));
        const extRun = await run(ctx, `printf '%s' ${extractPy} | base64 -d | python3 - ${shq(tmp + ".resp")} ${shq(outWsl)}`, exec, { timeoutMs: 30000 });
        await run(ctx, `rm -f ${shq(tmp + ".resp")}`, exec, { timeoutMs: 5000 }).catch(() => {});
        if (!extRun.stdout.text.trim().startsWith("OK")) {
          throw new Error(`voice_speak: ${extRun.stdout.text.trim().replace(/^ERR:/, "")}`);
        }
        // Duration from the WAV header; the artifact lands in long/ + manifest
        // (playable strip) unless the caller gave an explicit outPath.
        const buf = await readFile(outWsl);
        const seconds = wavDurationSeconds(buf);
        const notify = args.notify === true;
        const audioDir = resolveAudioDir(current().audio, resolveDshHome());
        const plan = planSpeechArtifact({
          outPath: args.outPath ? outWsl : null,
          audioDir,
          id: newAudioId(),
          text: args.text,
          voice: voiceName,
          model,
          notify,
          // agent.id is the branded SessionId (the whole agent.session object is
          // the live session, not its identifier).
          sessionId: exec?.agent?.id ?? null,
          callId: exec?.callId ?? null,
        });
        if (plan.manifest) {
          await initAudioStore(audioDir);
          try {
            await writeFile(plan.path, buf);
            await manifestAppend(audioDir, plan.manifest);
          } finally {
            // Temp extraction file (only exists when no outPath was given).
            await rm(outWsl, { force: true }).catch(() => {});
          }
        }
        const result = { path: plan.path, bytes: buf.length, notify };
        if (seconds > 0) result.seconds = Math.round(seconds * 10) / 10;
        if (plan.manifest) result.audioUrl = `/_dsh/voice-mimo/audio/${plan.manifest.id}`;
        return result;
      },
    }),
  );

  logger?.info?.("[dsh-voice-mimo] registered voice_transcribe + voice_speak (MiMo backend)");

  // Web Settings route (vision-toolkit pattern): serves/updates the voice map.
  const { installVoiceMimoWeb } = await import("./web.js");
  installVoiceMimoWeb(ctx, getSettings, updateSettings);
}

export { Config, apply, inject, name };
