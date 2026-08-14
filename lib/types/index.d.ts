/** Type surface for dsh-voice. */
import type { Context } from "@deepseek-ai/cordis";

export interface SttConfig {
  enabled: boolean;
  /** OpenAI-compatible `/audio/transcriptions` base URL. */
  apiBase: string;
  apiKey: string;
  apiKeyEnv: string;
  model: string;
  language: string;
  timeoutMs: number;
}

export interface TtsConfig {
  enabled: boolean;
  /** OpenAI-compatible `/audio/speech` base URL. */
  apiBase: string;
  apiKey: string;
  apiKeyEnv: string;
  model: string;
  voice: string;
  format: string;
  timeoutMs: number;
}

export interface VoiceConfig {
  stt: SttConfig;
  tts: TtsConfig;
}

export const name: string;
export const inject: string[];
export const Config: import("@deepseek-ai/schemastery").Schema<VoiceConfig>;
export function apply(ctx: Context, config: VoiceConfig): void;
