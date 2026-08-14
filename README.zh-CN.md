<p align="center">
  <a href="https://github.com/zhuiyueya/dsh-voice/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/dsh--plugin-✔-2563eb" alt="dsh-plugin"></a>
  <a href="https://github.com/zhuiyueya/dsh-voice"><img src="https://img.shields.io/github/stars/zhuiyueya/dsh-voice?style=social" alt="Stars"></a>
  <a href="https://github.com/zhuiyueya/dsh-voice"><img src="https://img.shields.io/github/last-commit/zhuiyueya/dsh-voice" alt="Last commit"></a>
</p>

<h1 align="center">🎤&nbsp;🔊&nbsp;dsh-voice</h1>

<p align="center"><strong>给 DeepSeek Harness 补上声音 —— 让纯文本的 DeepSeek 拥有「耳朵」和「嘴巴」。</strong></p>

<p align="center">
  <a href="README.md">English</a> · <a href="#中文">中文</a>
</p>

---

DeepSeek 的对话 API 是**纯文本**的——既听不懂音频、也说不出话。**dsh-voice** 在输入/输出边界把声音桥接成文本，模型全程只看到文本，却获得完整的语音回路：

```
🎤 语音 → 文本 → DeepSeek（纯文本）→ 文本 → 🔊 语音
```

> 和 [`dsh-vision-bridge`](https://github.com/zhuiyueya/dsh-vision-bridge) 是同一思路（把图片在进模型前转成文本）——只是这次补的是**听觉**，这块 DeepSeek Harness 的多模态空白还没人填。

## ✨ 功能

| | 层级 | 作用 |
|---|---|---|
| 🎤 | **语音输入（STT）— Web UI** | 输入框工具行里的麦克风按钮。点击说话，转写结果通过浏览器 **Web Speech API** 直接写入输入框。 |
| 🔊 | **朗读（TTS）— Web UI** | 每条 assistant 回复上的朗读按钮。点击用 **speechSynthesis** 把这条回答读出来。 |
| 📄 | **`voice_transcribe` 工具** | 把附件的音频文件（`wav/mp3/m4a/ogg/webm/flac`）转成文字，走任意 Whisper 兼容的 `/audio/transcriptions` 端点。 |
| 🗣️ | **`voice_speak` 工具** | 把文本合成语音文件，走任意 OpenAI 兼容的 `/audio/speech` 端点。 |

- ✅ **Web UI 零 API key** —— 纯浏览器语音，开箱即用。
- ✅ **不换模型** —— DeepSeek 仍是纯文本，语音在边缘处理。
- ✅ **后端可配** —— 指向本地 [whisper.cpp](https://github.com/ggerganov/whisper.cpp) / [Kokoro](https://github.com/hexgrad/kokoro)，即可做到完全免费、免 key。

## 🧭 工作原理

```
┌──────────────────────────────────────────────────────────────┐
│                         dsh Web GUI                           │
│                                                              │
│   你说话  ──🎤 SpeechRecognition──►  文本  ──►  输入框          │
│                                                              │
│   回复文本 ──🔊 speechSynthesis──►  你听到                     │
└──────────────────────────────────────────────────────────────┘
         │                                  ▲
         │ 文本（STT）                       │ 文本（TTS）
         ▼                                  │
┌──────────────────────────────────────────────────────────────┐
│              DeepSeek（纯文本模型）                            │
└──────────────────────────────────────────────────────────────┘

附件音频 ── voice_transcribe（Whisper 兼容）──► 文本 ──► 模型
模型想说话 ── voice_speak（OpenAI 兼容 TTS）──► 音频文件
```

## 📦 安装

```sh
# 从本地目录安装
dsh plugin --profile web add "file:/path/to/dsh-voice"

# 或（发布到 npm 后）
dsh plugin --profile web add dsh-voice
```

激活是自动的：包内自带 bundle patch（`cordis.patch.yml`）并声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把它注册进 profile 的 bundles。

然后重启 `dsh web`（或等待 HMR）。你应在输入框看到 **🎤**、在每条回复上看到 **🔊**。

## ⚙️ 配置

Web UI **无需任何配置**。如需自定义转写/朗读的语言、语速、音调，编辑 [`lib/client.js`](lib/client.js) 顶部的常量（`STT_LANG` / `TTS_LANG` / `TTS_RATE` / `TTS_PITCH`）。

Agent 工具通过 `settings.yaml` 的 `voice:` 命名空间配置（可在 Web 设置页热更新）：

```yaml
voice:
  stt:                        # voice_transcribe 工具
    enabled: true
    apiBase: ""               # 留空 = https://api.openai.com/v1
                              # 本地 whisper.cpp：http://127.0.0.1:8080/v1
    apiKeyEnv: VOICE_STT_API_KEY
    model: whisper-1
    language: ""              # zh / en / ... ；空 = 自动检测
  tts:                        # voice_speak 工具
    enabled: true
    apiBase: ""               # 留空 = https://api.openai.com/v1
    apiKeyEnv: VOICE_TTS_API_KEY
    model: tts-1
    voice: alloy              # alloy/echo/fable/onyx/nova/shimmer，或本地服务的 voice id
    format: mp3
```

> **完全免费 / 免 key**：把 `stt.apiBase` 指向本地 [whisper.cpp](https://github.com/ggerganov/whisper.cpp) 的 OpenAI 兼容 server，把 `tts.apiBase` 指向实现了 `/audio/speech` 的本地 Kokoro / Piper HTTP 包装。

## 🧰 Agent 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `voice_transcribe` | `path`（音频文件）、`language?` | `{ text, language }` |
| `voice_speak` | `text`、`outPath?`、`voice?` | `{ path, bytes }` |

## 🗂 项目结构

```
dsh-voice/
├── package.json          # 双半插件：host（main）+ browser（client）
├── cordis.patch.yml      # bundle 激活层
├── lib/
│   ├── index.js          # host 半：settings + voice_transcribe/voice_speak 工具
│   ├── client.js         # browser 半：🎤 / 🔊 按钮
│   └── types/
│       ├── index.d.ts
│       └── client/index.d.ts
├── README.md             # 英文版
└── README.zh-CN.md       # 本文件（中文版）
```

## 🗺 路线图

- [ ] 把浏览器 UI 的语言 / 语速 / 音调 / 自动朗读接入 `voice:` 设置页（目前为代码内常量）
- [ ] `autoRead`：回复完成后自动朗读
- [ ] 内置免费 `edge-tts` 后端（无需 OpenAI key）
- [ ] 基于 `@xenova/transformers` 的本地 Whisper STT
- [ ] 长文本分句朗读、流式打断

## 🙏 致谢

设计时参考了这些「给其他 agent 补语音」的成熟方案：

- [slopus/happy](https://github.com/slopus/happy)（~23k★）—— 实时语音交互形态
- [mbailey/voicemode](https://github.com/mbailey/voicemode)（~1.3k★）—— Claude Code 语音模式
- [caiovicentino/claude-call](https://github.com/caiovicentino/claude-call) —— 本地 Whisper STT + edge-tts、免 key
- [edge-tts](https://www.npmjs.com/package/edge-tts) —— 免费微软 Edge 神经语音
- [ggerganov/whisper.cpp](https://github.com/ggerganov/whisper.cpp) / OpenAI Whisper —— 语音识别
- [hexgrad/kokoro](https://github.com/hexgrad/kokoro) —— 本地神经 TTS

## 📄 License

[MIT](LICENSE)
