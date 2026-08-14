<p align="center">
  <a href="https://github.com/zhuiyueya/dsh-voice/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/dsh--plugin-✔-2563eb" alt="dsh-plugin"></a>
  <a href="https://github.com/zhuiyueya/dsh-voice"><img src="https://img.shields.io/github/stars/zhuiyueya/dsh-voice?style=social" alt="Stars"></a>
  <a href="https://github.com/zhuiyueya/dsh-voice"><img src="https://img.shields.io/github/last-commit/zhuiyueya/dsh-voice" alt="Last commit"></a>
</p>

<h1 align="center">🎤&nbsp;🔊&nbsp;dsh-voice</h1>

<p align="center"><strong>Voice for DeepSeek Harness — give text-only DeepSeek ears and a mouth.</strong></p>

<p align="center">
  <a href="#english">English</a> · <a href="README.zh-CN.md">中文</a>
</p>

---

DeepSeek's chat API is **text-only** — it can neither hear audio nor speak. **dsh-voice** bridges sound at the input/output boundary so the model never sees raw audio, yet gains a full voice loop:

```
🎤 speech → text → DeepSeek (text-only) → text → 🔊 speech
```

> Same idea as [`dsh-vision-bridge`](https://github.com/zhuiyueya/dsh-vision-bridge) — but for **audio**, the multimodal gap nobody has filled for DeepSeek Harness yet.

## ✨ Features

| | Layer | What it does |
|---|---|---|
| 🎤 | **Voice input (STT)** — Web UI | A mic button in the composer tool row. Click to speak; the transcript is written straight into the input box via the browser **Web Speech API**. |
| 🔊 | **Read-aloud (TTS)** — Web UI | A speaker button on every assistant reply. Click to read it aloud via **speechSynthesis**. |
| 📄 | **`voice_transcribe` tool** | Transcribe an attached audio file (`wav/mp3/m4a/ogg/webm/flac`) through any Whisper-compatible `/audio/transcriptions` endpoint. |
| 🗣️ | **`voice_speak` tool** | Synthesize text into an audio file through any OpenAI-compatible `/audio/speech` endpoint. |

- ✅ **Zero API key** for the Web UI — pure browser speech, works out of the box.
- ✅ **Zero new model** — DeepSeek stays text-only; speech is handled at the edge.
- ✅ **Configurable backends** — point at local [whisper.cpp](https://github.com/ggerganov/whisper.cpp) / [Kokoro](https://github.com/hexgrad/kokoro) for a fully free, keyless stack.

## 🧭 How it works

```
┌──────────────────────────────────────────────────────────────┐
│                         dsh Web GUI                           │
│                                                              │
│   you speak  ──🎤 SpeechRecognition──►  text  ──► input box   │
│                                                              │
│   reply text ──🔊 speechSynthesis──►  you hear                │
└──────────────────────────────────────────────────────────────┘
         │                                  ▲
         │ text (STT)                       │ text (TTS)
         ▼                                  │
┌──────────────────────────────────────────────────────────────┐
│              DeepSeek (text-only model)                       │
└──────────────────────────────────────────────────────────────┘

attached audio ── voice_transcribe (Whisper-compatible) ──► text ──► model
model wants to speak ── voice_speak (OpenAI-compatible TTS) ──► audio file
```

## 📦 Install

```sh
# from a local checkout
dsh plugin --profile web add "file:/path/to/dsh-voice"

# or, once published to npm
dsh plugin --profile web add dsh-voice
```

Activation is automatic: the package ships a bundle patch (`cordis.patch.yml`) and declares `dsh.bundle.patch`, so `dsh plugin add` registers it into the profile's bundles for you.

Then restart `dsh web` (or wait for HMR). You should see **🎤** in the composer and **🔊** on each reply.

## ⚙️ Configuration

The **🎤 mic button needs `voice.stt.apiBase`** (the browser records audio and sends it to the host's Whisper-compatible backend). The **🔊 read-aloud needs nothing** (browser `speechSynthesis`). To customize read-aloud language/rate/pitch, edit the constants at the top of [`lib/client.js`](lib/client.js) (`TTS_LANG`, `TTS_RATE`, `TTS_PITCH`).

`settings.yaml`:

```yaml
voice:
  stt:                        # mic button + voice_transcribe tool
    enabled: true
    apiBase: ""               # REQUIRED for the mic. Examples:
                              #   SiliconFlow: https://api.siliconflow.cn/v1
                              #   local whisper.cpp: http://127.0.0.1:8080/v1
    apiKeyEnv: VOICE_STT_API_KEY
    model: whisper-1
    language: ""              # zh / en / ... ; empty = auto-detect
  tts:                        # voice_speak tool
    enabled: true
    apiBase: ""               # empty = https://api.openai.com/v1
    apiKeyEnv: VOICE_TTS_API_KEY
    model: tts-1
    voice: alloy              # alloy/echo/fable/onyx/nova/shimmer, or a local voice id
    format: mp3
```

> **Why the mic needs a backend**: Chrome's built-in `SpeechRecognition` uploads audio to Google, which is unreachable in some regions (you'd see `识别出错：network`). dsh-voice records with `MediaRecorder` and transcribes through *your* Whisper-compatible backend instead. Two free, keyless options:
> - **[SiliconFlow](https://siliconflow.cn)** (China-friendly, free tier) — `apiBase: https://api.siliconflow.cn/v1`, model `FunAudioLLM/SenseVoiceSmall` or `whisper-1`.
> - **Local [whisper.cpp](https://github.com/ggerganov/whisper.cpp)** — fully offline, `apiBase: http://127.0.0.1:8080/v1` (no key).

## 🧰 Agent tools

| Tool | Parameters | Returns |
|---|---|---|
| `voice_transcribe` | `path` (audio file), `language?` | `{ text, language }` |
| `voice_speak` | `text`, `outPath?`, `voice?` | `{ path, bytes }` |

## 🗂 Project layout

```
dsh-voice/
├── package.json          # dual-half plugin: host (main) + browser (client)
├── cordis.patch.yml      # bundle activation layer
├── lib/
│   ├── index.js          # host half: settings + voice_transcribe/voice_speak tools
│   ├── client.js         # browser half: 🎤 / 🔊 buttons
│   └── types/
│       ├── index.d.ts
│       └── client/index.d.ts
├── README.md             # this file
└── README.zh-CN.md       # 中文版
```

## 🗺 Roadmap

- [ ] Wire browser-UI language / rate / pitch / auto-read into the `voice:` settings page (currently code constants)
- [ ] `autoRead`: auto read-aloud on reply completion
- [ ] Built-in free `edge-tts` backend (no OpenAI key)
- [ ] Local Whisper STT via `@xenova/transformers`
- [ ] Sentence-level reading with streaming interruption

## 🙏 Credits

Inspired by these established voice solutions for other agents:

- [slopus/happy](https://github.com/slopus/happy) (~23k★) — realtime voice interaction UX
- [mbailey/voicemode](https://github.com/mbailey/voicemode) (~1.3k★) — Claude Code voice mode
- [caiovicentino/claude-call](https://github.com/caiovicentino/claude-call) — local Whisper STT + edge-tts, no API key
- [edge-tts](https://www.npmjs.com/package/edge-tts) — free Microsoft Edge neural voices
- [ggerganov/whisper.cpp](https://github.com/ggerganov/whisper.cpp) / OpenAI Whisper — speech recognition
- [hexgrad/kokoro](https://github.com/hexgrad/kokoro) — local neural TTS

## 📄 License

[MIT](LICENSE)
