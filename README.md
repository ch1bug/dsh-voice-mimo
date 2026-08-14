# dsh-voice-mimo

Xiaomi MiMo-powered voice for DeepSeek Harness: a browser-native 🎤/🧠/🔊 UI
plus agent tools — `voice_transcribe` (MiMo ASR), `voice_understand`
(MiMo-v2.5 semantic analysis), `voice_speak` (MiMo TTS with a configurable
voice map: preset / voicedesign / voiceclone).

> **Fork of [zhuiyueya/dsh-voice](https://github.com/zhuiyueya/dsh-voice) (MIT).**
> The Settings page structure follows [Anionex/dsh-vision-toolkit](https://github.com/Anionex/dsh-vision-toolkit) (MIT).
> All three copyright notices are preserved in [LICENSE](LICENSE).

## What it gives you

| Layer | Capability | Backend |
|---|---|---|
| 🎤 | **Voice input** — mic button in the composer, transcript written into the input box | Browser Web Speech API (zero key) |
| 🔊 | **Read-aloud** — speaker button on every assistant reply, voice configurable in Settings (朗读音色) | **Xiaomi MiMo TTS** via host `/_dsh/voice-mimo/speak` |
| 📄 | **`voice_transcribe` tool** — audio file → text | **Xiaomi MiMo ASR** (`mimo-v2.5-asr`) |
| 🗣️ | **`voice_speak` tool** — text → spoken audio file; renders as a playable strip/card in the conversation | **Xiaomi MiMo TTS** (`mimo-v2.5-tts` / `-voicedesign`) |
| ⚙️ | **Settings page** — 朗读音色 for 🔊 + voice map + `audio.inlineThreshold`/`longRetain*` retention policy, live-applied | DSH Settings (vision-toolkit pattern) |

Unlike upstream dsh-voice (which targets OpenAI-compatible `/audio/transcriptions`
and `/audio/speech` endpoints), this fork calls the MiMo API directly — MiMo has
no OpenAI-compatible audio endpoints, so the tools are wired to its native
chat-completions format (ASR text in the assistant message, TTS in `audio`).

## Audio output routes (host)

The 🔊 read-aloud path runs entirely through two same-origin host routes
(node fetch/fs — no 64KB shell stdout cap):

- `POST /_dsh/voice-mimo/speak {text}` — synthesize via MiMo TTS into
  `audioDir/tmp/` (default `~/.dsh/cache/voice-mimo/tmp/`), record a manifest
  entry, return `{id, audioUrl, bytes, voice, model}`. The voice comes from
  Settings `tts.voice` (朗读音色) at request time, so a Settings change
  applies on the next click.
- `GET /_dsh/voice-mimo/audio/<id>.wav` — stream a stored file to the browser
  (id resolved through the manifest, path confined to the audioDir subtree).

Storage skeleton (layered `tmp/` + `long/`, per the audio-output spec):

```
audioDir (Settings `audio.dir`, default ~/.dsh/cache/voice-mimo/)
├── tmp/            🔊 read-aloud artifacts — play-once; cleared on DSH startup
├── long/           agent voice_speak artifacts — playable/downloadable strips
└── manifest.json   append-only JSONL: {id, sessionId, callId, path, createdAt, text, voice, model, notify}
```

The plugin reads/writes only inside its audioDir subtree; `voice_speak` still
respects an explicit `outPath`. DSH startup (`apply`) recreates the skeleton
and clears leftover `tmp/` contents idempotently.

## Agent speech in the conversation (#3)

`voice_speak` without an explicit `outPath`:

- writes the wav into `audioDir/long/` and appends a manifest row carrying the
  calling session id + call id (for later archive cleanup / regenerate);
- returns `{path, bytes, audioUrl, seconds, notify}` — the `audioUrl` streams
  the file via `GET /_dsh/voice-mimo/audio/<id>.wav`;
- the client renders the tool result as a compact play strip (≤
  `audio.inlineThreshold` seconds, default 30) or a full card (> threshold),
  each with ▶ playback and ⬇ download.

With an explicit `outPath` the exact path is written instead (no strip, no
manifest row). The Settings `audio.*` fields (`inlineThreshold`,
`longRetainCount`, `longRetainDays`) tune presentation/retention live.

## Speaking style & singing (#6/#7)

MiMo TTS exposes rich prosody control; `voice_speak` surfaces it as:

- **`style`** (default Settings `tts.style` = "温柔"): a natural-language
  instruction (e.g. `轻快上扬`, or a full director-style paragraph). The style
  is applied through a mixed channel — preset/voiceclone voices carry it in the
  user message; voicedesign voices (whose user message is the voice description)
  get an inline `(style)` tag prefix on the text.
- **`sing: true`** (preset voices only): the text is prefixed with `(唱歌)` —
  put lyrics in `text`. Combined with a style it becomes `(唱歌 style)`.
  Inline tags in the text (`(风格)`, `[叹气]`, …) pass through untouched.
- **`truncated`**: text beyond 2500 chars (official segmentation guidance) is
  cut explicitly and the result flags `truncated: true`.

The manifest row records `style` so a later regenerate can replay the timbre
plus the prosody. Preset voices follow the official list (mimo_default /
冰糖 / 茉莉 / 苏打 / 白桦 / Mia / Chloe / Milo / Dean).

## Install

```sh
dsh plugin --profile web add /path/to/dsh-voice-mimo
# or: dsh plugin --profile web add github:ch1bug/dsh-voice-mimo
```

Configure the MiMo key through DSH Credentials as `XIAOMI_API_KEY` (the web
Models page writes it), then open **Settings → Voice** to adjust the voice map.

## Pairing: audio file input

Drag-and-drop / paste of audio files into the workspace path is provided by
the separate [dsh-drop-to-path](https://github.com/loudMore/dsh-drop-to-path)
plugin — install it alongside so audio files reach the agent as workspace
paths that `voice_transcribe` can read:

```sh
dsh plugin --profile web add /path/to/dsh-drop-to-path
```

## License

MIT — see [LICENSE](LICENSE). Upstream dsh-voice (zhuiyueya) and the
vision-toolkit settings pattern (Anionex) retain their copyright notices.

## MiMo API 调用规范(官方文档确认)

- **音频理解**(`mimo-v2.5`):`messages` 可带 `system` 身份提示;content 用
  `input_audio`(data URL,Base64 ≤50MB)+ `text` 提示词;格式 wav/mp3/flac/m4a/ogg。
- **语音识别**(`mimo-v2.5-asr`):仅 wav/mp3,Base64 ≤10MB;content 只含
  `input_audio`(**不能**带 text part);语种走 `asr_options.language`
  (auto/zh/en)。官方示例与本插件实现一致。
- **语音合成**(`mimo-v2.5-tts` 系):目标文本在 assistant 消息,音色在
  `audio.voice`;voicedesign 不能带 voice 需 `optimize_text_preview`。
