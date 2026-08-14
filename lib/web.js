/**
 * dsh-voice-mimo — Settings route (vision-toolkit pattern, MIT).
 *
 * A same-origin endpoint that serves the current voice-map settings to the
 * Settings page and accepts updates. The schema and live-apply semantics
 * follow Anionex/dsh-vision-toolkit (lib/web.js), rewritten for the voice
 * namespace.
 */
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  entryAbsolutePath,
  initAudioStore,
  manifestAppend,
  manifestFind,
  newAudioId,
  resolveAudioDir,
} from "./audio-store.js";
import { resolveTtsTarget, speakMiMo } from "./tts.js";

export const SETTINGS_ROUTE = "/_dsh/voice-mimo/settings";
export const IMPORT_ROUTE = "/_dsh/voice-mimo/import";
export const LOG_ROUTE = "/_dsh/voice-mimo/log";
export const TRANSCRIBE_ROUTE = "/_dsh/voice-mimo/transcribe";
export const SPEAK_ROUTE = "/_dsh/voice-mimo/speak";
/** Prefix route: GET /_dsh/voice-mimo/audio/<id>.wav streams a stored file. */
export const AUDIO_PREFIX = "/_dsh/voice-mimo/audio";

const NS = settingsNamespace("voice-mimo");

/** Default MiMo provider used when the settings namespace is unavailable. */
const DEFAULT_PROVIDER = { baseUrl: "https://api.xiaomimimo.com/v1", credential: "XIAOMI_API_KEY" };

/** Audio ids are ours alone (newAudioId): alphanumeric + ._- + .wav. */
const AUDIO_ID_PATTERN = /^[A-Za-z0-9._-]+\.wav$/;

/** Largest accepted JSON body for /speak (text + envelope; TTS text is small). */
const MAX_SPEAK_BODY_BYTES = 256 * 1024;

/** Error class distinguishing "missing audio" (404) from real failures (500). */
export class AudioLookupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Transcribe an audio data URL through MiMo ASR. Called by the 🎤 button:
 * the browser records, encodes WAV, and POSTs { dataBase64 } here; the host
 * forwards to MiMo directly (node fetch — no 64KB shell stdout cap) and
 * returns the transcript so the client can drop it into the composer.
 */
async function transcribeMiMo(ctx, dataBase64, language) {
  const provider = (() => {
    try {
      const settings = ctx.get("settings");
      const desc = settings?.describe?.().find((row) => row.ns === NS);
      return desc?.value?.provider ?? DEFAULT_PROVIDER;
    } catch {
      return DEFAULT_PROVIDER;
    }
  })();
  const baseUrl = (provider.baseUrl || DEFAULT_PROVIDER.baseUrl).replace(/\/+$/, "");
  const credential = provider.credential || DEFAULT_PROVIDER.credential;
  const credentials = ctx.get("credentials");
  if (credentials === undefined) throw new Error("credentials service unavailable");
  const resolved = await credentials.resolve(credential);
  if (resolved === undefined) {
    throw new Error(`credential ${credential} is not configured; store it through DSH Credentials`);
  }
  const bytes = Buffer.from(dataBase64, "base64");
  const durl = "data:audio/wav;base64," + bytes.toString("base64");
  const payload = {
    model: "mimo-v2.5-asr",
    messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: durl } }] }],
    stream: false,
  };
  if (language) payload.asr_options = { language };
  // Retry once on an empty transcript: MiMo occasionally returns an empty
  // reply for audio; a second attempt usually succeeds.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "api-key": resolved.value, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`MiMo ASR HTTP ${response.status}: ${text.slice(0, 400)}`);
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.length > 0) return content;
  }
  throw new Error("MiMo ASR returned an empty transcript");
}

/**
 * Resolve the MiMo API key from DSH Credentials (shared by speak + tools).
 */
async function resolveMimoKey(ctx, credential) {
  const credentials = ctx.get("credentials");
  if (credentials === undefined) throw new Error("credentials service is unavailable");
  const resolved = await credentials.resolve(credential || DEFAULT_PROVIDER.credential);
  if (resolved === undefined) {
    throw new Error(`credential ${credential || DEFAULT_PROVIDER.credential} is not configured; store it through DSH Credentials`);
  }
  return resolved.value;
}

/** Provider settings (live from the settings namespace). */
function providerOf(getSettings) {
  const provider = getSettings().value?.provider;
  return {
    baseUrl: provider?.baseUrl || DEFAULT_PROVIDER.baseUrl,
    credential: provider?.credential || DEFAULT_PROVIDER.credential,
  };
}

/**
 * 🔊 read-aloud: synthesize `text` via MiMo TTS into audioDir/tmp, record the
 * manifest entry, and return { id, audioUrl, bytes, voice, model }.
 *
 * Voice resolution: optional explicit `voice` (forward-compatible with
 * regenerate), else Settings `tts.voice` (朗读音色), else "alloy". The
 * manifest entry carries {text, voice, model} so later slices can rebuild.
 */
export async function performSpeak(ctx, getSettings, { text, voice } = {}, deps = {}) {
  const t = typeof text === "string" ? text.trim() : "";
  if (t.length === 0) throw new Error("text is required");
  const value = getSettings().value ?? {};
  const tts = value.tts ?? {};
  const provider = providerOf(getSettings);
  const dir = resolveAudioDir(value, resolveDshHome());
  await initAudioStore(dir);
  const apiKey = await resolveMimoKey(ctx, provider.credential);
  const voiceName = (typeof voice === "string" && voice.trim().length > 0 ? voice.trim() : tts.voice) || "alloy";
  const target = resolveTtsTarget(tts, value.voiceMap, voiceName);
  if (target.needsReference) {
    throw new Error(
      `朗读音色 "${voiceName}" 映射到 voiceclone 模型,需要参考音频;请在 Settings 选择 preset/voicedesign 音色,或改用 voice_speak 工具带 reference 参数`,
    );
  }
  const { bytes } = await speakMiMo({
    baseUrl: provider.baseUrl,
    apiKey,
    target,
    text: t,
    format: tts.format || "wav",
    timeoutMs: tts.timeoutMs || 60000,
    fetchImpl: deps.fetchImpl,
  });
  const id = newAudioId();
  const rel = `tmp/${id}`;
  await writeFile(join(dir, rel), bytes);
  const entry = await manifestAppend(dir, { id, rel, text: t, voice: voiceName, model: target.model });
  const audioUrl = `${AUDIO_PREFIX}/${id}`;
  return { id, audioUrl, bytes: bytes.length, voice: voiceName, model: target.model, createdAt: entry.createdAt };
}

/** Validate an audio id path segment; throws AudioLookupError on anything unexpected. */
export function parseAudioId(raw) {
  if (typeof raw !== "string" || !AUDIO_ID_PATTERN.test(raw)) {
    throw new AudioLookupError("invalid-id", "invalid audio id");
  }
  return raw;
}

/**
 * GET /audio/<id>.wav: resolve a manifest entry to a confined absolute path.
 * Returns { path, bytes } or throws: AudioLookupError → 404, anything else
 * (real I/O failure) → 500.
 */
export async function performAudio(ctx, getSettings, rawId) {
  const id = parseAudioId(rawId);
  const value = getSettings().value ?? {};
  const dir = resolveAudioDir(value, resolveDshHome());
  const entry = await manifestFind(dir, id);
  if (!entry) throw new AudioLookupError("not-found", `audio ${id} not found`);
  const path = entryAbsolutePath(dir, entry);
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new AudioLookupError("not-found", `audio ${id} missing on disk`);
    }
    throw error; // real fs failures → 500
  }
  if (!info.isFile()) throw new AudioLookupError("not-found", `audio ${id} missing on disk`);
  return { path, bytes: info.size };
}

/**
 * HTTP decision layer for POST /speak (kept separate from the raw req/res
 * handler so the whole mapping is testable without a server):
 *   { status, json } on every path; status 200/400/500.
 */
export async function speakHttp(ctx, getSettings, body, deps = {}) {
  const text = body && typeof body.text === "string" ? body.text.trim() : "";
  if (text.length === 0) {
    return { status: 400, json: { ok: false, error: { code: "invalid-request", message: "text is required" } } };
  }
  try {
    const result = await performSpeak(ctx, getSettings, { text, voice: body.voice }, { fetchImpl: deps.fetchImpl });
    return { status: 200, json: { ok: true, value: result } };
  } catch (error) {
    return { status: 500, json: { ok: false, error: { code: "speak-error", message: errorMessage(error) } } };
  }
}

/**
 * HTTP decision layer for GET /audio/<id>: 200 with { path, bytes } (caller
 * streams) or 404 (missing/invalid id) / 500 (real failure) with JSON.
 */
export async function audioHttp(ctx, getSettings, rawId) {
  try {
    const { path, bytes } = await performAudio(ctx, getSettings, rawId);
    return { status: 200, path, bytes };
  } catch (error) {
    if (error instanceof AudioLookupError) {
      return { status: 404, json: { ok: false, error: { code: "audio-not-found", message: error.message } } };
    }
    return { status: 500, json: { ok: false, error: { code: "audio-error", message: errorMessage(error) } } };
  }
}

/** Client diagnostic log file under the DSH home logs/. */
function clientLogPath() {
  const base = resolveDshHome();
  return join(base, "logs", "voice-mimo-client.log");
}

/** Append a structured client event to the diagnostic log. */
async function appendClientLog(entry) {
  try {
    const file = clientLogPath();
    await mkdir(join(file, ".."), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    await appendFile(file, line, "utf8");
  } catch {
    /* logging must never break the app */
  }
}

/** Audio extensions accepted by the 🧠 understand button. */
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac", ".webm", ".mp4"]);
const MAX_AUDIO_BYTES = 100 * 1024 * 1024; // 100MB
const DROP_DIR = ".voice-imports";

/** Resolve the active session workspace root (same as dsh-drop-to-path). */
async function workspaceRoot() {
  const dshHome = resolveDshHome();
  const store = join(dshHome, "storages", "workspace.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(store, "utf8"));
  } catch (error) {
    throw new Error(`cannot read workspace registry: ${error instanceof Error ? error.message : String(error)}`);
  }
  const workspaces = parsed?.tables?.workspaces;
  if (typeof workspaces !== "object" || workspaces === null) throw new Error("workspace registry is empty");
  const ids = Object.keys(workspaces);
  if (ids.length === 0) throw new Error("no workspace registered");
  let best = ids[0];
  for (const id of ids) {
    if ((workspaces[id].updatedAt ?? "") > (workspaces[best].updatedAt ?? "")) best = id;
  }
  const path = workspaces[best]?.path;
  if (typeof path !== "string" || path.length === 0) throw new Error("workspace has no path");
  return path;
}

/** Sanitize an uploaded file name (preserve Unicode; strip path/control chars). */
function safeName(raw) {
  const base = basename(String(raw ?? ""))
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .trim()
    .slice(0, 120);
  return base.length === 0 ? "audio" : base;
}

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error("payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Attach the Settings + audio-import routes whenever a webServer is present. */
export function installVoiceMimoWeb(ctx, getSettings, updateSettings) {
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => {
      const settingsDispose = webCtx.webServer.register({
        kind: "exact",
        path: SETTINGS_ROUTE,
        handler: async (req, res) => {
          const respond = (value, status = 200) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(value));
          };
          try {
            if (req.method === "GET") {
              const snapshot = getSettings();
              respond({ ok: true, value: { settings: snapshot.value, revision: snapshot.revision, writable: snapshot.writable } });
              return;
            }
            if (req.method === "POST") {
              if (!(await getSettings().writable)) {
                respond({ ok: false, error: { code: "readonly", message: "settings are read-only in this profile" } }, 403);
                return;
              }
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              const result = await updateSettings(body.value, body.expectedRevision);
              if (!result.ok) {
                respond({ ok: false, error: { code: "invalid", message: result.message } }, 400);
                return;
              }
              respond({ ok: true, value: { revision: result.revision } });
              return;
            }
            respond({ ok: false, error: { code: "method-not-allowed", message: "Use GET or POST" } }, 405);
          } catch (error) {
            respond({ ok: false, error: { code: "settings-error", message: error instanceof Error ? error.message : String(error) } }, 500);
          }
        },
      });
      const importDispose = webCtx.webServer.register({
        kind: "exact",
        path: IMPORT_ROUTE,
        handler: async (req, res) => {
          const respond = (value, status = 200) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(value));
          };
          try {
            if (req.method !== "POST") {
              respond({ ok: false, error: { code: "method-not-allowed", message: "Use POST" } }, 405);
              return;
            }
            let body;
            try {
              body = JSON.parse(await readBody(req, MAX_AUDIO_BYTES + 1024 * 1024));
            } catch (error) {
              respond({ ok: false, error: { code: "invalid-request", message: error instanceof Error ? error.message : String(error) } }, 400);
              return;
            }
            const { name: rawName, dataBase64 } = body;
            if (typeof dataBase64 !== "string" || dataBase64.length === 0) {
              respond({ ok: false, error: { code: "invalid-request", message: "Missing dataBase64" } }, 400);
              return;
            }
            const bytes = Buffer.from(dataBase64, "base64");
            const safe = safeName(rawName);
            const dot = safe.lastIndexOf(".");
            const ext = (dot >= 0 ? safe.slice(dot) : "").toLowerCase();
            if (!AUDIO_EXTENSIONS.has(ext)) {
              respond({ ok: false, error: { code: "unsupported-type", message: `Unsupported audio extension "${ext}"; expected wav/mp3/m4a/flac/ogg/aac/webm/mp4` } }, 415);
              return;
            }
            if (bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) {
              respond({ ok: false, error: { code: "too-large", message: `File exceeds ${Math.floor(MAX_AUDIO_BYTES / 1024 / 1024)}MB` } }, 413);
              return;
            }
            const root = await workspaceRoot();
            const dir = join(root, DROP_DIR);
            await mkdir(dir, { recursive: true });
            const target = join(dir, `${Date.now()}-${safe}`);
            await writeFile(target, bytes);
            respond({ ok: true, value: { path: target, filename: basename(target), bytes: bytes.length } });
          } catch (error) {
            respond({ ok: false, error: { code: "import-failed", message: error instanceof Error ? error.message : String(error) } }, 500);
          }
        },
      });
      const logDispose = webCtx.webServer.register({
        kind: "exact",
        path: LOG_ROUTE,
        handler: async (req, res) => {
          const respond = (value, status = 200) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(value));
          };
          try {
            if (req.method !== "POST") {
              respond({ ok: false, error: { code: "method-not-allowed", message: "Use POST" } }, 405);
              return;
            }
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            await appendClientLog({ kind: "client", event: body.event ?? "unknown", detail: body.detail ?? null });
            respond({ ok: true });
          } catch (error) {
            respond({ ok: false, error: { code: "log-error", message: error instanceof Error ? error.message : String(error) } }, 500);
          }
        },
      });
      const transcribeDispose = webCtx.webServer.register({
        kind: "exact",
        path: TRANSCRIBE_ROUTE,
        handler: async (req, res) => {
          const respond = (value, status = 200) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(value));
          };
          try {
            if (req.method !== "POST") {
              respond({ ok: false, error: { code: "method-not-allowed", message: "Use POST" } }, 405);
              return;
            }
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            const { dataBase64, language } = body;
            if (typeof dataBase64 !== "string" || dataBase64.length === 0) {
              respond({ ok: false, error: { code: "invalid-request", message: "Missing dataBase64" } }, 400);
              return;
            }
            const text = await transcribeMiMo(ctx, dataBase64, typeof language === "string" ? language : "");
            respond({ ok: true, value: { text } });
          } catch (error) {
            respond({ ok: false, error: { code: "transcribe-error", message: error instanceof Error ? error.message : String(error) } }, 500);
          }
        },
      });
      const speakDispose = webCtx.webServer.register({
        kind: "exact",
        path: SPEAK_ROUTE,
        handler: async (req, res) => {
          if (req.method !== "POST") {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: { code: "method-not-allowed", message: "Use POST" } }));
            return;
          }
          let body;
          try {
            body = JSON.parse(await readBody(req, MAX_SPEAK_BODY_BYTES) || "{}");
          } catch (error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: { code: "invalid-request", message: errorMessage(error) } }));
            return;
          }
          const { status, json } = await speakHttp(ctx, getSettings, body);
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(json));
        },
      });
      const audioDispose = webCtx.webServer.register({
        kind: "prefix",
        path: AUDIO_PREFIX,
        handler: async (req, res) => {
          if (req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: { code: "method-not-allowed", message: "Use GET" } }));
            return;
          }
          const rawPath = new URL(req.url ?? "/", "http://x").pathname;
          const rawId = rawPath.slice(AUDIO_PREFIX.length).replace(/^\/+/, "");
          const outcome = await audioHttp(ctx, getSettings, rawId);
          if (outcome.status !== 200) {
            res.writeHead(outcome.status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(outcome.json));
            return;
          }
          res.writeHead(200, {
            "Content-Type": "audio/wav",
            "Content-Length": String(outcome.bytes),
            "Cache-Control": "no-store",
          });
          const stream = createReadStream(outcome.path);
          stream.on("error", (error) => {
            // File vanished between stat() and read (e.g. tmp cleanup): abort
            // the response instead of crashing the host.
            ctx.logger?.warn?.(`[dsh-voice-mimo] audio stream error: ${errorMessage(error)}`);
            res.destroy();
          });
          stream.pipe(res);
        },
      });
      return () => {
        settingsDispose();
        importDispose();
        logDispose();
        transcribeDispose();
        speakDispose();
        audioDispose();
      };
    }, "voice-mimo: settings + import + log + transcribe + speak + audio routes");
  });
}
