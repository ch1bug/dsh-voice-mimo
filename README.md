# dsh-voice-mimo

Voice for DeepSeek Harness backed by **Xiaomi MiMo**: a browser-native voice UI
plus agent tools that call MiMo ASR/TTS directly, with a configurable voice map.

> **Fork of [zhuiyueya/dsh-voice](https://github.com/zhuiyueya/dsh-voice) (MIT).**
> The Settings page structure follows [Anionex/dsh-vision-toolkit](https://github.com/Anionex/dsh-vision-toolkit) (MIT).
> All three copyright notices are preserved in [LICENSE](LICENSE).

## What it gives you

| Layer | Capability | Backend |
|---|---|---|
| 🎤 | **Voice input** — mic button in the composer, transcript written into the input box | Browser Web Speech API (zero key) |
| 🔊 | **Read-aloud** — speaker button on every assistant reply | Browser `speechSynthesis` (zero key) |
| 📄 | **`voice_transcribe` tool** — audio file → text | **Xiaomi MiMo ASR** (`mimo-v2.5-asr`) |
| 🗣️ | **`voice_speak` tool** — text → spoken audio file | **Xiaomi MiMo TTS** (`mimo-v2.5-tts` / `-voicedesign`) |
| ⚙️ | **Settings page** — configure the voice map (OpenAI voice names → MiMo presets / voice design), live-applied | DSH Settings (vision-toolkit pattern) |

Unlike upstream dsh-voice (which targets OpenAI-compatible `/audio/transcriptions`
and `/audio/speech` endpoints), this fork calls the MiMo API directly — MiMo has
no OpenAI-compatible audio endpoints, so the tools are wired to its native
chat-completions format (ASR text in the assistant message, TTS in `audio`).

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
