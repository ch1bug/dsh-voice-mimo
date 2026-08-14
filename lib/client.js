/**
 * dsh-voice-mimo — browser half (fork of dsh-voice, MIT).
 *
 * Adds two controls to the DeepSeek Harness Web GUI:
 *
 *  • 🎤 at `conversation.input.left`  — hold-to-transcribe speech input. Uses
 *    the Web Speech API (SpeechRecognition) and writes the transcript into the
 *    composer draft via `inputActions.setDraft`.
 *  • 🔊 at `conversation.chat.assistant-actions` — read one assistant reply
 *    aloud. Uses the Web Speech API (speechSynthesis).
 *
 * Both are pure-browser (zero API key), so a text-only model like DeepSeek
 * gets a voice loop without any backend: mic → text → model → text → speaker.
 * The host half (lib/index.js) adds `voice_transcribe` / `voice_speak` tools
 * for audio FILES.
 *
 * Plain JavaScript, no JSX — build elements with React.createElement.
 */

window.__ModuleLoader__.load({
  id: "dsh-voice-mimo",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const { useState, useRef, useMemo, useEffect } = React;

    // ── tweakable defaults (per-browser; host-settings wiring is a roadmap item) ──
    const STT_LANG = ""; // "" = browser default; e.g. "zh-CN", "en-US"
    const TTS_LANG = ""; // "" = browser default
    const TTS_RATE = 1; // 0.5 .. 2
    const TTS_PITCH = 1; // 0 .. 2

    const inject = ["slots"];

    // ──────────────────────────────────────────────────────────────────────────
    // Mic button — SpeechRecognition → composer draft
    // ──────────────────────────────────────────────────────────────────────────
    // Diagnostic logging: POST client events to the host log route so the
    // exact Web Speech behaviour (start/result/error/end) is observable.
    function logVoice(event, detail) {
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(
            "/_dsh/voice-mimo/log",
            new Blob([JSON.stringify({ event, detail })], { type: "application/json" }),
          );
        } else {
          void fetch("/_dsh/voice-mimo/log", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event, detail }),
          });
        }
      } catch (_) { /* logging must never break the UI */ }
    }

    function MicButton(props) {
      const { input, inputActions } = props;
      const [listening, setListening] = useState(false);
      const stateRef = useRef(null);

      useEffect(() => {
        return () => {
          const s = stateRef.current;
          if (s && s.cleanup) {
            try { s.cleanup(); } catch (_) { /* ignore */ }
          }
        };
      }, []);

      const supported = () =>
        typeof window !== "undefined" &&
        !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
        typeof window.AudioContext !== "undefined";

      const stopRecording = () => {
        const s = stateRef.current;
        if (!s) return;
        // Stop tracks + processor; the data collection continues in the
        // recorder onstop handler.
        try { s.mediaRecorder && s.mediaRecorder.stop(); } catch (_) { /* ignore */ }
      };

      const start = async () => {
        if (!inputActions) return;

        // Clicking while listening stops the recording and transcribes it.
        if (stateRef.current && stateRef.current.mediaRecorder && stateRef.current.mediaRecorder.state === "recording") {
          stopRecording();
          return;
        }

        let stream;
        let audioCtx;
        let source;
        let processor;
        const chunks = [];

        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
          logVoice("mic-perm-denied", { name: err && err.name, message: err && err.message });
          window.alert("无法访问麦克风：请在浏览器地址栏左侧允许本页使用麦克风。（" + (err && err.name) + "）");
          return;
        }

        try {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          source = audioCtx.createMediaStreamSource(stream);
          // ScriptProcessor collects raw PCM; 16kHz mono keeps payloads small.
          processor = audioCtx.createScriptProcessor(4096, 1, 1);
          const samples = [];
          processor.onaudioprocess = (e) => {
            const data = e.inputBuffer.getChannelData(0);
            // Downsample 48k → 16k naive: take every 3rd sample.
            for (let i = 0; i < data.length; i += 3) samples.push(data[i]);
          };
          source.connect(processor);
          processor.connect(audioCtx.destination);

          const mediaRecorder = new MediaRecorder(stream);
          mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
          };
          mediaRecorder.onstop = async () => {
            // Encode collected PCM to a 16-bit mono 16kHz WAV.
            const wav = encodeWav(new Float32Array(samples), 16000);
            const blob = new Blob([wav], { type: "audio/wav" });
            const reader = new FileReader();
            reader.onload = () => {
              const dataBase64 = String(reader.result).split(",")[1] || "";
              logVoice("mic-recorded", { bytes: blob.size, seconds: Math.round(samples.length / 16000) });
              setListening(false);
              transcribeAndDraft(dataBase64);
            };
            reader.onerror = () => { logVoice("mic-read-fail", null); setListening(false); };
            reader.readAsDataURL(blob);
          };
          mediaRecorder.onerror = (e) => {
            logVoice("mic-recorder-error", { error: String(e && e.error) });
            setListening(false);
          };
          mediaRecorder.start();
          stateRef.current = {
            mediaRecorder,
            cleanup: () => {
              try { mediaRecorder.stop(); } catch (_) { /* ignore */ }
              try { processor.disconnect(); } catch (_) { /* ignore */ }
              try { source.disconnect(); } catch (_) { /* ignore */ }
              try { audioCtx.close(); } catch (_) { /* ignore */ }
              stream.getTracks().forEach((t) => t.stop());
            },
          };
          logVoice("mic-start", { recorder: true });
          setListening(true);
        } catch (err) {
          logVoice("mic-setup-fail", { message: err && err.message });
          stream.getTracks().forEach((t) => t.stop());
          window.alert("录音初始化失败：" + (err && err.message));
        }
      };

      const transcribeAndDraft = (dataBase64) => {
        logVoice("mic-transcribe-request", { bytes: Math.round((dataBase64.length * 3) / 4) });
        fetch("/_dsh/voice-mimo/transcribe", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataBase64, language: STT_LANG || "" }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) throw new Error(d.error?.message || "transcribe failed");
            const text = d.value.text;
            logVoice("mic-transcribed", { text });
            // Defer the draft write out of the fetch/render microtask so the
            // store dispatch happens on a clean frame (avoids React #321
            // "cannot update during render" when the callback fires while a
            // render is in flight).
            setTimeout(() => {
              try {
                const draft = (input && input.draft) || "";
                const sep = draft && !/[\s\u3000]$/.test(draft) ? " " : "";
                inputActions.setDraft(draft + sep + text);
              } catch (err) {
                logVoice("mic-setdraft-error", { message: err && err.message });
              }
            }, 0);
          })
          .catch((err) => {
            logVoice("mic-transcribe-error", { message: err.message });
            window.alert("转写失败：" + (err.message || err));
          });
      };

      return React.createElement(
        "button",
        {
          type: "button",
          className: "dsh-voice-btn dsh-voice-mic" + (listening ? " is-listening" : ""),
          onClick: () => { void start(); },
          title: listening ? "正在录音，点击停止并转写" : "语音输入（录音→MiMo 转写）",
          "aria-label": "语音输入",
          disabled: !supported() || !inputActions,
        },
        listening ? "●" : "🎤",
      );
    }

    // Encode raw interleaved Float32 PCM (mono) into a 16-bit PCM WAV Blob.
    function encodeWav(samples, sampleRate) {
      const buffer = new ArrayBuffer(44 + samples.length * 2);
      const view = new DataView(buffer);
      const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
      };
      writeStr(0, "RIFF");
      view.setUint32(4, 36 + samples.length * 2, true);
      writeStr(8, "WAVE");
      writeStr(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); // PCM
      view.setUint16(22, 1, true); // mono
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true); // byte rate
      view.setUint16(32, 2, true); // block align
      view.setUint16(34, 16, true); // bits per sample
      writeStr(36, "data");
      view.setUint32(40, samples.length * 2, true);
      let offset = 44;
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
      return buffer;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Understand button — pick an audio file → upload to workspace → draft path
    // ──────────────────────────────────────────────────────────────────────────
    function UnderstandButton(props) {
      const { input, inputActions } = props;
      const [busy, setBusy] = useState(false);
      const fileRef = useRef(null);

      const pick = () => {
        if (!fileRef.current) return;
        fileRef.current.value = "";
        fileRef.current.click();
      };

      const onFile = (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file || !inputActions) return;
        setBusy(true);
        const reader = new FileReader();
        reader.onload = () => {
          const dataBase64 = String(reader.result).split(",")[1] || "";
          fetch("/_dsh/voice-mimo/import", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: file.name, dataBase64 }),
          })
            .then((r) => r.json())
            .then((d) => {
              if (!d.ok) throw new Error(d.error?.message || "upload failed");
              const path = d.value.path;
              const hint = "（请用 voice_understand 理解这段音频）";
              setTimeout(() => {
                try {
                  const draft = (input && input.draft) || "";
                  const sep = draft && !/[\s\u3000]$/.test(draft) ? " " : "";
                  inputActions.setDraft(draft + sep + path + " " + hint);
                } catch (err) {
                  logVoice("understand-setdraft-error", { message: err && err.message });
                }
              }, 0);
              setBusy(false);
            })
            .catch((err) => {
              setBusy(false);
              if (typeof window !== "undefined") window.alert("音频上传失败: " + (err.message || err));
            });
        };
        reader.onerror = () => { setBusy(false); };
        reader.readAsDataURL(file);
      };

      return React.createElement(
        "span",
        { style: { display: "inline-flex", alignItems: "center" } },
        React.createElement("input", {
          ref: fileRef,
          type: "file",
          accept: ".wav,.mp3,.m4a,.flac,.ogg,.aac,.webm,.mp4,audio/*",
          style: { display: "none" },
          onChange: onFile,
        }),
        React.createElement(
          "button",
          {
            type: "button",
            className: "dsh-voice-btn dsh-voice-understand" + (busy ? " is-listening" : ""),
            onClick: pick,
            title: busy ? "上传中…" : "理解音频文件（上传并让 agent 分析）",
            "aria-label": "理解音频文件",
            disabled: busy || !inputActions,
          },
          busy ? "⏳" : "🧠",
        ),
      );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Speaker button — read one assistant reply aloud
    // ──────────────────────────────────────────────────────────────────────────
    function SpeakerButton(props) {
      const { messageId, useSession } = props;
      const [speaking, setSpeaking] = useState(false);

      const session = typeof useSession === "function" ? useSession() : null;

      const text = useMemo(() => {
        if (!session || !Array.isArray(session.nodes)) return "";
        const node = session.nodes.find(
          (n) => n && n.kind === "assistant" && n.messageId === messageId,
        );
        if (!node || !Array.isArray(node.blocks)) return "";
        return node.blocks
          .filter((b) => b && b.kind === "text" && b.text)
          .map((b) => b.text)
          .join("\n")
          .trim();
      }, [session, messageId]);

      useEffect(() => {
        return () => {
          if (typeof window !== "undefined" && window.speechSynthesis) {
            window.speechSynthesis.cancel();
          }
        };
      }, []);

      const speak = () => {
        if (!text || !window.speechSynthesis) return;
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = TTS_LANG;
        u.rate = TTS_RATE;
        u.pitch = TTS_PITCH;
        u.onend = () => setSpeaking(false);
        u.onerror = () => setSpeaking(false);
        setSpeaking(true);
        window.speechSynthesis.speak(u);
      };

      return React.createElement(
        "button",
        {
          type: "button",
          className: "dsh-voice-btn dsh-voice-speaker" + (speaking ? " is-speaking" : ""),
          onClick: speak,
          title: speaking ? "停止朗读" : "朗读这条回答",
          "aria-label": "朗读这条回答",
          disabled: !text || !window.speechSynthesis,
        },
        "🔊",
      );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Plugin body
    // ──────────────────────────────────────────────────────────────────────────
    function apply(ctx) {
      // One shared style tag, removed on unload.
      let styleEl = document.getElementById("dsh-voice-style");
      if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = "dsh-voice-style";
        styleEl.textContent = [
          ".dsh-voice-btn{",
          "  appearance:none;background:transparent;border:1px solid transparent;",
          "  border-radius:6px;cursor:pointer;font-size:14px;line-height:1;",
          "  padding:4px 6px;opacity:.7;transition:opacity .12s, background .12s, border-color .12s;",
          "}",
          ".dsh-voice-btn:hover{opacity:1;background:rgba(128,128,128,.12)}",
          ".dsh-voice-btn:disabled{opacity:.3;cursor:default}",
          ".dsh-voice-btn.is-listening,.dsh-voice-btn.is-speaking{",
          "  color:#e5484d;border-color:#e5484d;opacity:1;",
          "}",
        ].join("\n");
        document.head.append(styleEl);
      }
      ctx.effect(() => {
        return () => {
          if (styleEl && styleEl.isConnected) styleEl.remove();
        };
      }, "dsh-voice: remove styles");

      ctx.slots.inject("conversation.input.left", () => {
        const dispose = ctx.slots.register(
          { name: "conversation.input.left", id: "dsh-voice-mic", order: 20 },
          MicButton,
        );
        const disposeUnderstand = ctx.slots.register(
          { name: "conversation.input.left", id: "dsh-voice-understand", order: 30 },
          UnderstandButton,
        );
        return () => { dispose(); disposeUnderstand(); };
      });

      ctx.slots.inject("conversation.chat.assistant-actions", () => {
        const dispose = ctx.slots.register(
          { name: "conversation.chat.assistant-actions", id: "dsh-voice-speaker", order: 30 },
          SpeakerButton,
        );
        return () => dispose();
      });

      // Settings page — voice map editor (vision-toolkit pattern, MIT).
      // Structure follows dsh-vision-toolkit's Settings section; the voice-map
      // table is this fork's own editor for the Config.voiceMap entries.
      ctx.slots.inject("settings.section", () => ctx.slots.register(
        {
          name: "settings.section",
          id: "dsh-voice-mimo",
          order: 40,
          label: () => "Voice (MiMo)",
        },
        SettingsSection,
      ));
    }

    function SettingsSection(props) {
      const { useState, useEffect } = React;
      const [state, setState] = useState({ loading: true, draft: null, revision: 0, writable: false, error: null, saving: false });
      const load = () => {
        setState((s) => ({ ...s, loading: true, error: null }));
        fetch("/_dsh/voice-mimo/settings", { credentials: "same-origin" })
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) throw new Error(d.error?.message || "failed to load");
            setState({ loading: false, draft: d.value.settings, revision: d.value.revision, writable: d.value.writable, error: null, saving: false });
          })
          .catch((e) => setState((s) => ({ ...s, loading: false, error: e.message })));
      };
      useEffect(load, []);
      const save = () => {
        setState((s) => ({ ...s, saving: true, error: null }));
        fetch("/_dsh/voice-mimo/settings", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: state.draft, expectedRevision: state.revision }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) throw new Error(d.error?.message || "save failed");
            setState((s) => ({ ...s, saving: false, revision: d.value.revision }));
          })
          .catch((e) => setState((s) => ({ ...s, saving: false, error: e.message })));
      };
      const setRow = (name, field, value) => {
        const draft = { ...state.draft, voiceMap: { ...state.draft.voiceMap } };
        if (!draft.voiceMap[name]) draft.voiceMap[name] = { type: "preset", voice: "", model: "" };
        draft.voiceMap[name] = { ...draft.voiceMap[name], [field]: value };
        setState((s) => ({ ...s, draft }));
      };
      const addRow = () => {
        const draft = { ...state.draft, voiceMap: { ...state.draft.voiceMap } };
        const name = `voice-${Date.now().toString(36)}`;
        draft.voiceMap[name] = { type: "preset", voice: "mimo_default", model: "" };
        setState((s) => ({ ...s, draft }));
      };
      const removeRow = (name) => {
        const draft = { ...state.draft, voiceMap: { ...state.draft.voiceMap } };
        delete draft.voiceMap[name];
        setState((s) => ({ ...s, draft }));
      };

      if (state.loading) return React.createElement("div", null, "Loading voice settings…");
      if (state.error) return React.createElement("div", { style: { color: "#e5484d" } }, state.error);
      const rows = Object.entries(state.draft.voiceMap || {});
      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "12px", padding: "12px" } },
        React.createElement("h3", null, "Voice map"),
        React.createElement("p", { style: { fontSize: "13px", opacity: 0.7 } },
          "Map OpenAI voice names (alloy/echo/fable/onyx/nova/shimmer) used by voice_speak to MiMo presets or voice design descriptions. Changes apply live."),
        React.createElement(
          "table",
          { style: { borderCollapse: "collapse", width: "100%" } },
          React.createElement("thead", null, React.createElement("tr", null,
            React.createElement("th", { style: tableTh }, "Voice name"),
            React.createElement("th", { style: tableTh }, "Type"),
            React.createElement("th", { style: tableTh }, "MiMo preset / description"),
            React.createElement("th", { style: tableTh }, "Model (auto = by type)"),
            React.createElement("th", { style: tableTh }, ""),
          )),
          React.createElement("tbody", null,
            rows.map(([name, entry]) => React.createElement("tr", { key: name },
              React.createElement("td", { style: tableTd }, name),
              React.createElement("td", { style: tableTd },
                React.createElement("select", { value: entry.type, onChange: (e) => setRow(name, "type", e.target.value) },
                  React.createElement("option", { value: "preset" }, "preset"),
                  React.createElement("option", { value: "voicedesign" }, "voicedesign"),
                )),
              React.createElement("td", { style: tableTd },
                entry.type === "preset"
                  ? React.createElement("select", { value: entry.voice, onChange: (e) => setRow(name, "voice", e.target.value) },
                      ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dea"].map((v) =>
                        React.createElement("option", { key: v, value: v }, v)),
                    )
                  : React.createElement("input", { value: entry.voice, onChange: (e) => setRow(name, "voice", e.target.value), placeholder: "e.g. 低沉男声", style: { width: "100%" } }),
              ),
              React.createElement("td", { style: tableTd },
                React.createElement("select", { value: entry.model || "", onChange: (e) => setRow(name, "model", e.target.value) },
                  React.createElement("option", { value: "" }, "auto"),
                  React.createElement("option", { value: "mimo-v2.5-tts" }, "mimo-v2.5-tts"),
                  React.createElement("option", { value: "mimo-v2.5-tts-voicedesign" }, "mimo-v2.5-tts-voicedesign"),
                  React.createElement("option", { value: "mimo-v2.5-tts-voiceclone" }, "mimo-v2.5-tts-voiceclone"),
                )),
              React.createElement("td", { style: tableTd },
                React.createElement("button", { onClick: () => removeRow(name) }, "✕"),
              ),
            )),
          ),
        ),
        React.createElement("div", { style: { display: "flex", gap: "8px" } },
          React.createElement("button", { onClick: addRow }, "+ Add voice"),
          React.createElement("button", { onClick: save, disabled: !state.writable || state.saving }, state.saving ? "Saving…" : "Save"),
        ),
      );
    }
    const tableTh = { textAlign: "left", padding: "6px 10px", borderBottom: "1px solid rgba(128,128,128,.3)" };
    const tableTd = { padding: "6px 10px", borderBottom: "1px solid rgba(128,128,128,.15)" };

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
