/**
 * dsh-voice-mimo — audio directory store (audioDir skeleton).
 *
 * Layer-0 storage shared by every audio-output slice (spec #1, issue #2):
 *
 *   audioDir (default ~/.dsh/cache/voice-mimo/, Settings `audio.dir`)
 *   ├── tmp/            temporary: 🔊 read-aloud, notify instant playback;
 *   │                   cleared on DSH startup (apply) — play-once, discard
 *   ├── long/           long-term: agent voice_speak artifacts; cleaned per
 *   │                   archived session + loose retention fallback (#4/#5)
 *   └── manifest.json   append-only JSONL: {id, sessionId, callId, path,
 *                       createdAt, text, voice, model, notify}
 *
 * The plugin reads/writes ONLY inside the audioDir subtree. User-provided
 * `outPath` for voice_speak stays outside on purpose (spec decision).
 *
 * Pure functions on a `dir` argument (resolved per request from live
 * settings), so every operation is trivially testable against a temp dir.
 */

import { mkdir, readFile, appendFile, readdir, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export const MANIFEST_NAME = "manifest.json";
export const TMP_DIR = "tmp";
export const LONG_DIR = "long";

/** Default audioDir root: <dshHome>/cache/voice-mimo. */
export function defaultAudioDir(dshHome) {
  return join(dshHome, "cache", "voice-mimo");
}

/** Normalize a Windows path (C:\...) to a WSL path (host runs under WSL). */
export function wslPathOf(path) {
  const s = String(path).replace(/\\/g, "/");
  return /^([A-Za-z]):\//.test(s) ? "/mnt/" + s[0].toLowerCase() + s.slice(2) : s;
}

/**
 * Resolve the audioDir from live settings (`audio.dir`, empty = default).
 * Accepts Windows or WSL paths; always returns an absolute WSL path.
 */
export function resolveAudioDir(settingsValue, dshHome) {
  const dir = settingsValue?.audio?.dir;
  if (typeof dir === "string" && dir.trim().length > 0) return wslPathOf(dir.trim());
  return defaultAudioDir(dshHome ?? process.env.HOME ?? "/root");
}

/**
 * Ensure tmp/ + long/ exist under audioDir. Idempotent.
 * Returns the resolved audioDir.
 */
export async function initAudioStore(dir) {
  await mkdir(join(dir, TMP_DIR), { recursive: true });
  await mkdir(join(dir, LONG_DIR), { recursive: true });
  return dir;
}

/**
 * Remove every entry inside tmp/ (startup cleanup of the previous process's
 * leftovers). Idempotent: missing dir is fine, an empty tmp/ is a no-op.
 * Never touches anything outside audioDir/tmp.
 */
export async function cleanTmp(dir) {
  const tmp = join(dir, TMP_DIR);
  await mkdir(tmp, { recursive: true });
  const entries = await readdir(tmp);
  await Promise.all(entries.map((entry) => rm(join(tmp, entry), { recursive: true, force: true })));
}

/** Build a unique audio file name (used for tmp artifacts and ids). */
export function newAudioId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.wav`;
}

/**
 * Append one manifest entry (JSONL, append-only). `rel` is the path of the
 * artifact relative to audioDir (e.g. "tmp/m-xxx.wav"); `id` is the lookup
 * key used by GET /audio/<id>.
 */
export async function manifestAppend(dir, { id, rel, sessionId = null, callId = null, text = "", voice = "", model = "", notify = false }) {
  const entry = {
    id,
    sessionId,
    callId,
    path: rel,
    createdAt: new Date().toISOString(),
    text,
    voice,
    model,
    notify,
  };
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, MANIFEST_NAME), JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

/** Read all manifest entries (JSONL lines; corrupt lines are skipped). */
export async function manifestEntries(dir) {
  const file = join(dir, MANIFEST_NAME);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      /* skip corrupt line */
    }
  }
  return entries;
}

/** Find one manifest entry by id (null when absent). */
export async function manifestFind(dir, id) {
  const entries = await manifestEntries(dir);
  return entries.find((entry) => entry && entry.id === id) ?? null;
}

/**
 * Confine a manifest `path` (relative to audioDir) inside audioDir: resolve
 * against dir and reject any traversal outside the subtree. Returns the
 * absolute path. Throws on escape or non-relative values.
 */
export function confinePath(dir, rel) {
  const resolvedDir = resolve(dir);
  const abs = resolve(resolvedDir, rel);
  const relCheck = relative(resolvedDir, abs);
  if (relCheck === "" || relCheck === ".." || relCheck.startsWith(".." + sep)) {
    throw new Error(`path escapes audioDir: ${rel}`);
  }
  return abs;
}

/** Absolute path of a manifest entry (confinement-checked). */
export function entryAbsolutePath(dir, entry) {
  if (!entry || typeof entry.path !== "string") throw new Error("manifest entry has no path");
  return confinePath(dir, entry.path);
}

/** stat() the tmp/ dir (for tests/diagnostics): {entries, bytes}. */
export async function tmpStats(dir) {
  const tmp = join(dir, TMP_DIR);
  let names = [];
  try {
    names = await readdir(tmp);
  } catch {
    return { entries: 0, bytes: 0 };
  }
  let bytes = 0;
  for (const name of names) {
    try {
      bytes += (await stat(join(tmp, name))).size;
    } catch {
      /* skip */
    }
  }
  return { entries: names.length, bytes };
}
