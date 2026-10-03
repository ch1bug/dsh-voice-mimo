# ⚠️ DEPRECATED — this repo is archived

**dsh-voice-mimo has been absorbed into
[dsh-mimo-agent-tools](https://github.com/ch1bug/dsh-mimo-agent-tools)**
(single-repo decision, [docs/adr/0001](https://github.com/ch1bug/dsh-mimo-agent-tools/blob/main/docs/adr/0001-single-mimo-transport.md)
in that repo). No new work lands here; see the issue tracker for the
migration trail (this repo #3/#4/#17, that repo #3/#4/#5).

## Where everything went

| What | Now lives at |
|---|---|
| 🎤/🔊 Browser voice UI (mic input, read-aloud, Settings → Voice, play strips/cards) | dsh-mimo-agent-tools **`./client`** entry (plugin `voice`) |
| 📄 `voice_transcribe` / 🗣️ `voice_speak` / `voice_understand` agent tools | dsh-mimo-agent-tools **`./mimo`** entry (tools `mimo_asr` / `mimo_speak` / `mimo_audio`) |
| Reusable MiMo TTS/ASR client (`ctx`-light export) | dsh-mimo-agent-tools `mimo` module export |

Migration carried over all capabilities: read-aloud fix, Plugins-tab settings,
manifest-faithful audio store, V2.6 default for `mimo_audio`
(`mimo-v2.5` retired upstream; ASR/TTS v2.5-series models unchanged).

## Install (new repo)

```sh
dsh plugin --profile web add github:ch1bug/dsh-mimo-agent-tools
```

Configure the MiMo key through DSH Credentials as `XIAOMI_API_KEY`, then open
**Settings → Plugins** for voice settings.

## License

MIT — see [LICENSE](LICENSE). Upstream dsh-voice (zhuiyueya) and the
vision-toolkit settings pattern (Anionex) retain their copyright notices.
