# Xiaomi MiMo TTS API — Capability Inventory (primary sources only)

Compiled from: official docs SPA content served at `https://mimo.mi.com/docs/` (same docs as `platform.xiaomimimo.com/#/docs`), the official `XiaomiMiMo/MiMo-Skills` GitHub repo, and the official HuggingFace org. Retrieval date: session date; doc `modifiedTime` values observed up to 2026-07.

## 1. Model lineup

Exactly three TTS models in the v2.5 family; **no v3 or other TTS model ids exist**. The older `mimo-v2-tts` was retired 2026-06-30 (official site banner: "MiMo-V2 系列模型已于 2026.6.30 00:00 正式下线"). HuggingFace org `XiaomiMiMo` hosts no TTS weights (TTS is API-only; ASR is `MiMo-V2.5-ASR`). [models page](https://mimo.mi.com/docs/models/mimo-v2-5-tts) · [HF org](https://huggingface.co/XiaomiMiMo)

| Model ID | Purpose | Constraints |
|---|---|---|
| `mimo-v2.5-tts` | Preset-voice synthesis; only model with singing mode `(唱歌)` | No voice design, no cloning. `audio.voice` optional, defaults to `mimo_default` |
| `mimo-v2.5-tts-voicedesign` | Voice from text description (user message = voice description, **required**) | `audio.voice` **not supported**; no singing/preset voices; optional `optimize_text_preview` |
| `mimo-v2.5-tts-voiceclone` | Clone voice from audio sample | `audio.voice` **required** = base64 data-URL of sample (mp3/wav only, ≤10 MB encoded); no singing/preset voices |

Source: [official API ref "语音合成（MiMo-TTS 系列）- OpenAI API 兼容"](https://mimo.mi.com/docs/api/audio/tts) and [usage guide "语音合成（MiMo-V2.5-TTS 系列）"](https://mimo.mi.com/docs/quick-start/usage-guide/audio/speech-synthesis-v2.5) · [SKILL.md](https://github.com/XiaomiMiMo/MiMo-Skills/blob/main/skills/mimo-v2-5-tts/SKILL.md)

## 2. The `audio` object (in chat/completions)

Only **three** fields are documented — nothing else:

- `format` (string, optional): `wav` (default), `mp3`, `pcm`, `pcm16` (`pcm`≡`pcm16`; use pcm16 when `stream:true`). **No ogg/flac.** — [API ref](https://mimo.mi.com/docs/api/audio/tts)
- `voice` (string): preset id or clone-sample data-URL. Full preset list: `mimo_default`, `冰糖`, `茉莉`, `苏打`, `白桦`, `Mia`, `Chloe`, `Milo`, `Dean` (mimo_default → 冰糖 on CN cluster, Mia elsewhere). — [API ref](https://mimo.mi.com/docs/api/audio/tts), [usage guide voice table](https://mimo.mi.com/docs/quick-start/usage-guide/audio/speech-synthesis-v2.5)
- `optimize_text_preview` (bool, default false, **voicedesign only**): smart-polishes target text; when true, the assistant message may be omitted and text is auto-generated. Response then includes `final_text_preview`. — [API ref](https://mimo.mi.com/docs/api/audio/tts)

`speed`/`rate`/`pitch`/`emotion`/`temperature`/`top_p`/`seed`: **not documented**. Prosody is controlled via natural-language user messages and inline audio tags (`(风格)` prefix tags; `[吸气]`/`(笑)` inline tags) instead of numeric params. — [usage guide](https://mimo.mi.com/docs/quick-start/usage-guide/audio/speech-synthesis-v2.5)

## 3. Beyond basic synthesis

- **Streaming**: yes, SSE via `stream: true`; audio chunks arrive base64 in `choices[0].delta.audio.data`, PCM16LE mono 24 kHz. True low-latency streaming is live **only for `mimo-v2.5-tts`**; voicedesign/voiceclone streaming is "degraded compatibility mode" (single result after full inference). — [usage guide streaming sections](https://mimo.mi.com/docs/quick-start/usage-guide/audio/speech-synthesis-v2.5)
- **SSML**: not documented (tags are parentheses/bracket style, not SSML).
- **Long text**: no hard API limit documented. Official SKILL.md advises single-shot generation and only segmenting (ffmpeg concat) beyond **2500 characters**. — [SKILL.md](https://github.com/XiaomiMiMo/MiMo-Skills/blob/main/skills/mimo-v2-5-tts/SKILL.md)
- **Multiple voices per request**: not documented.
- **Background music / sound-effect params**: not documented.
- Singing: `(唱歌)`/`(sing)`/`(singing)` prefix tag, `mimo-v2.5-tts` only, Chinese lyrics recommended. — [usage guide](https://mimo.mi.com/docs/quick-start/usage-guide/audio/speech-synthesis-v2.5)

## 4. Request/response shape

`POST https://api.xiaomimimo.com/v1/chat/completions`. Auth: header `api-key: $MIMO_API_KEY` **or** `Authorization: Bearer $MIMO_API_KEY`. Body: `{model, messages, audio, stream?}`; target text goes in the **assistant** message, style instructions in an optional **user** message. Non-stream response: `choices[0].message.audio.data` (base64 of requested format) plus `audio.id`, `audio.expires_at` (null), `audio.transcript` (null), optional `final_text_preview`, and `usage`. **No non-base64/binary mode documented.** — [API ref](https://mimo.mi.com/docs/api/audio/tts) · [official scripts](https://github.com/XiaomiMiMo/MiMo-Skills/tree/main/skills/mimo-v2-5-tts/scripts)

## 5. Pricing / limits

- All three TTS models: **限时免费 (limited-time free)** per [pricing page](https://mimo.mi.com/docs/price/pay-as-you-go); usage visible in console billing.
- Rate limits: 100 RPM / 10M TPM per model per account (all API keys summed). — [rate-limit doc](https://mimo.mi.com/docs/api/guidance/rate-limit)
- Voice-clone sample: ≤10 MB base64, mp3/wav only, MIME `audio/mpeg`|`audio/mp3`|`audio/wav`. — [API ref](https://mimo.mi.com/docs/api/audio/tts)
- Max output audio duration: not documented.
