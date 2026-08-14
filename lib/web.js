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
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export const SETTINGS_ROUTE = "/_dsh/voice-mimo/settings";
export const IMPORT_ROUTE = "/_dsh/voice-mimo/import";
export const LOG_ROUTE = "/_dsh/voice-mimo/log";
export const TRANSCRIBE_ROUTE = "/_dsh/voice-mimo/transcribe";

const NS = settingsNamespace("voice-mimo");

/** Default MiMo provider used when the settings namespace is unavailable. */
const DEFAULT_PROVIDER = { baseUrl: "https://api.xiaomimimo.com/v1", credential: "XIAOMI_API_KEY" };

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
      return () => {
        settingsDispose();
        importDispose();
        logDispose();
        transcribeDispose();
      };
    }, "voice-mimo: settings + import + log + transcribe routes");
  });
}
