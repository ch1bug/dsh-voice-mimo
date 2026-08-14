# CONTEXT.md — dsh-voice-mimo 领域词汇表

> 只收术语，不收实现。出现歧义/新术语时在此登记。

## 语音合成（MiMo TTS）术语

- **预置音色（preset）** — `mimo-v2.5-tts` 内置精品音色（mimo_default/冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean）。mimo_default 因部署集群而异（中国集群=冰糖）。官方音色名是 **Dean**（英文男声），不是 Dea。
- **音色设计（voicedesign）** — `mimo-v2.5-tts-voicedesign`：用文本描述定制音色。user 消息**必填**（放音色描述），`optimize_text_preview: true` 时可不传 assistant 消息。
- **音色复刻（voiceclone）** — `mimo-v2.5-tts-voiceclone`：参考音频（mp3/wav，≤10MB，data URL）复刻音色。
- **风格控制（style control）** — 控制语气/情绪/角色/方言的能力，官方提供两条互斥通道：
  - **音频标签（tag control）**：风格标签混在**目标文本**里（assistant content），如 `(温柔)恭喜`、`(唱歌)歌词`、`[叹气]`；多风格同括号 `(唱歌 温柔)`；半角/全角/方括号均可。全模型统一、与 voicedesign 不冲突。
  - **自然语言指令（prompt control）**：风格描述放在 **user 消息**（不入语音），支持导演模式（角色/场景/指导）、复合情绪、多粒度。voicedesign 的 user 消息被音色描述占用，需规避。
- **唱歌模式（singing）** — 仅 `mimo-v2.5-tts`；文本最开头 `(唱歌)歌词` 触发，歌词建议中文。
- **流式输出（streaming）** — `mimo-v2.5-tts` 低延迟流式已上线（需 `format: "pcm16"` 拼接）；voicedesign 流式未上线。本插件当前不做，已记 issue。
- **输出格式** — 非流式 `wav`；流式 `pcm16`（24kHz 单声道）。无 mp3 输出。

## 插件内术语

- **朗读音色（read-aloud voice）** — Settings `tts.voice`：🔊 与通知用哪个 voiceMap 音色（默认 alloy→冰糖）。
- **朗读语气（read-aloud style）** — Settings `tts.style`：🔊 与通知的默认风格（默认"温柔"）；`voice_speak` 的 `style` 参数显式传参时覆盖。
- **style 参数** — `voice_speak` 的 `style: string`（默认取 Settings `tts.style`）；**混合机制**：preset/voiceclone 走自然语言 user 消息（表达力全开），voicedesign 走音频标签前缀（规避 user 消息冲突）。manifest 记录 `style` 字段供重建重放。
- **sing 参数** — `voice_speak` 的 `sing: boolean`：true 时给文本加 `(唱歌)` 前缀；与 style 并存时合成 `(唱歌 温柔)` 同括号多风格。
