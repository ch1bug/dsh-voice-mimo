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

    // ── tweakable defaults (per-browser) ──
    const STT_LANG = ""; // "" = browser default; e.g. "zh-CN", "en-US"

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
    // Speaker button — read one assistant reply aloud with MiMo TTS
    // ──────────────────────────────────────────────────────────────────────────
    // Issue #2: no more browser speechSynthesis. Click → POST /speak → host
    // synthesizes via MiMo TTS into audioDir/tmp → <audio> plays the returned
    // audioUrl. Voice comes from Settings tts.voice (朗读音色), resolved
    // host-side, so a Settings change applies to the next click immediately.
    //
    // Playback states: idle → busy (synthesizing) → playing (click to stop) |
    // ready (autoplay blocked by browser policy; click plays the loaded file).
    let activeAudio = null;
    const audioStopListeners = new Set();
    function notifyAudioStopped() {
      for (const fn of audioStopListeners) fn();
    }
    function stopActiveAudio() {
      if (activeAudio) {
        try { activeAudio.pause(); } catch (_) { /* ignore */ }
        activeAudio = null;
        notifyAudioStopped();
      }
    }
    // Stop whatever else is playing WITHOUT letting the notify loop reset the
    // caller's own state (the caller asserts its state right after).
    function stopOthersExcept(handler) {
      if (handler) audioStopListeners.delete(handler);
      try {
        stopActiveAudio();
      } finally {
        if (handler) audioStopListeners.add(handler);
      }
    }

    // ── autoplay-unlock tracking (#4) ──
    // Chrome blocks audio.play() with sound until the user has interacted
    // with the domain. One pointerdown/keydown arms the flag (then the
    // listeners are forgotten); a successful play() also proves it.
    let userInteracted = false;
    let audioUnlocked = false;
    function interactionArm() {
      userInteracted = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("pointerdown", interactionArm);
        window.removeEventListener("keydown", interactionArm);
      }
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pointerdown", interactionArm, { passive: true });
      window.addEventListener("keydown", interactionArm, { passive: true });
    }
    function markAudioUnlocked() {
      audioUnlocked = true;
    }
    function canAutoplay() {
      return userInteracted || audioUnlocked;
    }

    // ── voice_speak toolview: playable strip / card for agent speech (#3) ──
    // The inline-vs-card threshold comes from Settings `audio.inlineThreshold`
    // (live: fetched with a short TTL, busted after a Settings save).
    let thresholdCache = { value: 30, at: 0 };
    function getInlineThreshold() {
      const now = Date.now();
      if (now - thresholdCache.at < 60000) return Promise.resolve(thresholdCache.value);
      return fetch("/_dsh/voice-mimo/settings", { credentials: "same-origin" })
        .then((r) => r.json())
        .then((d) => {
          const v = Number(d && d.ok && d.value && d.value.settings && d.value.settings.audio && d.value.settings.audio.inlineThreshold);
          if (Number.isFinite(v) && v > 0) thresholdCache = { value: v, at: now };
          return thresholdCache.value;
        })
        .catch(() => thresholdCache.value);
    }
    function bustThresholdCache() {
      thresholdCache = { value: thresholdCache.value, at: 0 };
    }
    // Parse the structured envelope the voice_speak tool renders as its second
    // text block: {path, bytes, audioUrl, seconds, notify}.
    function parseVoiceEnvelope(content) {
      if (!Array.isArray(content)) return null;
      for (const block of content) {
        if (block && block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          try {
            const v = JSON.parse(block.text);
            if (v && typeof v === "object" && typeof v.audioUrl === "string") return v;
          } catch (_) { /* not our envelope */ }
        }
      }
      return null;
    }
    function formatDuration(seconds) {
      const s = Math.max(0, Math.round(seconds || 0));
      if (s < 60) return s + "s";
      const m = Math.floor(s / 60);
      const r = s % 60;
      return m + ":" + String(r).padStart(2, "0");
    }

    function VoiceSpeakView(props) {
      const { block } = props;
      const [threshold, setThreshold] = useState(30);
      const [playing, setPlaying] = useState(false);
      // Highlight shown when a notify speech is blocked by the autoplay policy
      // (red dot + notification label); a click clears it.
      const [highlight, setHighlight] = useState(false);
      const audioRef = useRef(null);
      const stopHandlerRef = useRef(null);
      const playBtnRef = useRef(null);
      const mountedRef = useRef(true);

      useEffect(() => {
        let alive = true;
        getInlineThreshold().then((v) => { if (alive) setThreshold(v); });
        return () => { alive = false; };
      }, []);

      const settled = block && block.kind === "tool-result";
      const envelope = settled ? parseVoiceEnvelope(block.content) : null;
      const seconds = envelope && typeof envelope.seconds === "number" ? envelope.seconds : 0;
      const inline = seconds <= threshold;

      useEffect(() => {
        const handleStop = () => setPlaying(false);
        stopHandlerRef.current = handleStop;
        audioStopListeners.add(handleStop);
        return () => {
          mountedRef.current = false;
          audioStopListeners.delete(handleStop);
          const a = audioRef.current;
          if (a) {
            try { a.pause(); a.removeAttribute("src"); } catch (_) { /* ignore */ }
          }
          if (activeAudio === a) activeAudio = null;
        };
      }, []);

      const startPlayback = (autoplay) => {
        if (!envelope) return;
        stopOthersExcept(stopHandlerRef.current);
        const a = new Audio(envelope.audioUrl);
        audioRef.current = a;
        activeAudio = a;
        const settle = () => {
          if (mountedRef.current) setPlaying(false);
          if (activeAudio === a) activeAudio = null;
        };
        a.onended = settle;
        a.onerror = settle;
        const promise = a.play();
        if (promise && typeof promise.catch === "function") {
          promise
            .then(() => {
              if (!mountedRef.current) return;
              markAudioUnlocked();
              setHighlight(false);
            })
            .catch(() => {
              settle();
              // A blocked autoplay must not lose the notification: keep the
              // strip highlighted and clickable. User-initiated playback that
              // fails just settles (no highlight).
              if (autoplay) {
                logVoice("speak-autoplay-blocked", { notify: true });
                if (mountedRef.current) setHighlight(true);
              }
            });
        }
        setPlaying(true);
      };

      const toggle = () => {
        if (!envelope) return;
        if (playing) {
          stopActiveAudio();
          return;
        }
        startPlayback(false);
      };

      // notify speech: autoplay when the page is unlocked; otherwise highlight
      // and retry once on the first interaction. Deps on (settled, callId):
      // the toolview mounts while the call is still running (envelope absent),
      // so a mount-only effect would never fire.
      useEffect(() => {
        if (!settled || !envelope || !envelope.notify) return;
        if (canAutoplay()) {
          startPlayback(true);
          return;
        }
        setHighlight(true);
        const retry = (event) => {
          // A pointerdown landing on the strip's own play button is the
          // click that toggle() handles — let it play without double-starting.
          if (event && event.target && playBtnRef.current &&
              (event.target === playBtnRef.current || playBtnRef.current.contains(event.target))) {
            return;
          }
          cleanup();
          startPlayback(true);
        };
        const cleanup = () => {
          if (typeof window !== "undefined") {
            window.removeEventListener("pointerdown", retry);
            window.removeEventListener("keydown", retry);
          }
        };
        if (typeof window !== "undefined") {
          window.addEventListener("pointerdown", retry, { passive: true });
          window.addEventListener("keydown", retry, { passive: true });
        }
        return cleanup;
      }, [settled, block.callId]);

      // Fallback while running / when the envelope is missing: the plain text
      // summary line, so the tool row never renders empty.
      if (!envelope) {
        const text = settled && Array.isArray(block.content)
          ? block.content
              .filter((b) => b && b.type === "text" && b.text && !b.text.trim().startsWith("{"))
              .map((b) => b.text)
              .join(" ")
          : "";
        return React.createElement("div", { style: { fontSize: "12px", opacity: 0.75, padding: "4px 2px" } }, text || "…");
      }

      const downloadName = (envelope.path || "voice-speak.wav").split(/[\\/]/).pop();
      const rowStyle = {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px 10px",
        borderRadius: "8px",
        border: highlight
          ? "1px solid rgba(229,72,77,.7)"
          : "1px solid rgba(128,128,128,.25)",
        background: highlight ? "rgba(229,72,77,.08)" : "rgba(128,128,128,.06)",
        maxWidth: "100%",
      };
      const btnStyle = { background: "transparent", border: "none", cursor: "pointer", fontSize: "16px", lineHeight: 1, padding: "2px 4px" };
      const controls = [
        React.createElement("button", {
          key: "play",
          ref: playBtnRef,
          type: "button",
          onClick: toggle,
          style: btnStyle,
          title: playing ? "停止" : "播放",
          "aria-label": playing ? "停止" : "播放",
        }, playing ? "⏸" : "▶"),
        React.createElement("span", { key: "dur", style: { fontSize: "12px", opacity: 0.75, minWidth: "44px" } }, formatDuration(seconds)),
        React.createElement("a", {
          key: "dl",
          href: envelope.audioUrl,
          download: downloadName,
          style: { ...btnStyle, textDecoration: "none", fontSize: "13px" },
          title: "下载",
        }, "⬇"),
      ];
      if (envelope.notify && highlight) {
        // Blocked notification: explicit, clickable affordance (never lost).
        controls.unshift(
          React.createElement("span", {
            key: "notify",
            style: { fontSize: "11px", color: "#e5484d", fontWeight: 600, whiteSpace: "nowrap" },
          }, "🔴 通知"),
        );
      }
      if (inline) {
        return React.createElement("div", { style: rowStyle }, controls);
      }
      // Long speech (> inlineThreshold) renders as a distinct card.
      return React.createElement("div", {
        style: { ...rowStyle, flexDirection: "column", alignItems: "stretch", padding: "10px 12px", background: highlight ? "rgba(229,72,77,.08)" : "rgba(128,128,128,.09)" },
      },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", opacity: 0.7 } },
          React.createElement("span", null, envelope.notify && highlight ? "🔴 通知 · Agent 语音" : "Agent 语音"),
          React.createElement("span", null, formatDuration(seconds)),
        ),
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px" } }, controls),
      );
    }

    function SpeakerButton(props) {
      const { messageId, useSession } = props;
      const [state, setState] = useState("idle"); // idle | busy | playing | ready
      const audioRef = useRef(null);
      const abortRef = useRef(null);
      const stopHandlerRef = useRef(null);

      // session-scope slots inject `useSession` as a SELECTOR hook over the
      // current session snapshot. chat.nodes is a ChatNodeStore (values() →
      // nodes), so the selector resolves the array; the text extraction then
      // lives in the selector so streaming messages stay fresh.
      const text = typeof useSession === "function"
        ? useSession((s) => {
            const nodes = s?.chat?.nodes?.values?.() ?? [];
            const node = nodes.find((n) => n && n.kind === "assistant" && n.messageId === messageId);
            if (!node || !Array.isArray(node.blocks)) return "";
            return node.blocks
              .filter((b) => b && b.kind === "text" && b.text)
              .map((b) => b.text)
              .join("\n")
              .trim();
          })
        : "";
      // useMemo removed: the selector already memoizes on snapshot changes.

      useEffect(() => {
        // Any other message starting playback stops us (mirrors the old
        // global speechSynthesis.cancel() semantics).
        const handleStop = () => setState("idle");
        stopHandlerRef.current = handleStop;
        audioStopListeners.add(handleStop);
        return () => {
          audioStopListeners.delete(handleStop);
          if (abortRef.current) { try { abortRef.current.abort(); } catch (_) { /* ignore */ } }
          const a = audioRef.current;
          if (a) {
            try { a.pause(); a.removeAttribute("src"); } catch (_) { /* ignore */ }
          }
          if (activeAudio === a) activeAudio = null;
        };
      }, []);

      const playAudio = (url) => {
        stopOthersExcept(stopHandlerRef.current);
        const a = new Audio(url);
        audioRef.current = a;
        activeAudio = a;
        const settle = () => { setState("idle"); if (activeAudio === a) activeAudio = null; };
        a.onended = settle;
        a.onerror = () => {
          setState("idle");
          if (activeAudio === a) activeAudio = null;
          logVoice("speak-play-error", { message: String(a.error && a.error.message) });
          if (typeof window !== "undefined") window.alert("音频播放失败：" + String((a.error && a.error.message) || "unknown"));
        };
        const promise = a.play();
        if (promise && typeof promise.catch === "function") {
          promise.then(() => { markAudioUnlocked(); }).catch((err) => {
            // Autoplay policy: keep the loaded file, ask for one more click
            // (Chrome requires a user gesture for play() with sound).
            if (a === audioRef.current) setState("ready");
            if (activeAudio === a) activeAudio = null;
            logVoice("speak-autoplay-blocked", { name: err && err.name });
          });
        }
      };

      const speak = () => {
        if (state === "busy") return;
        if (state === "playing") {
          stopActiveAudio();
          return;
        }
        if (state === "ready" && audioRef.current) {
          // Playback was blocked before; this click is a user gesture.
          stopOthersExcept(stopHandlerRef.current);
          setState("playing");
          const a = audioRef.current;
          activeAudio = a;
          const promise = a.play();
          if (promise && typeof promise.catch === "function") {
            promise.then(() => { markAudioUnlocked(); }).catch((err) => {
              setState("idle");
              if (activeAudio === a) activeAudio = null;
              logVoice("speak-replay-error", { name: err && err.name, message: err && err.message });
            });
          }
          return;
        }
        if (!text) return;
        setState("busy");
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        logVoice("speak-request", { textLength: text.length });
        fetch("/_dsh/voice-mimo/speak", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: ctrl.signal,
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) throw new Error(d.error?.message || "synthesis failed");
            logVoice("speak-synthesized", { id: d.value.id, bytes: d.value.bytes, voice: d.value.voice });
            setState("playing");
            playAudio(d.value.audioUrl);
          })
          .catch((err) => {
            if (err && err.name === "AbortError") return;
            setState("idle");
            logVoice("speak-error", { message: err && err.message });
            if (typeof window !== "undefined") window.alert("语音合成失败：" + ((err && err.message) || err));
          });
      };

      const busy = state === "busy";
      const speaking = state === "playing";
      return React.createElement(
        "button",
        {
          type: "button",
          className:
            "dsh-voice-btn dsh-voice-speaker" +
            (busy || speaking ? " is-speaking" : "") +
            (state === "ready" ? " is-ready" : ""),
          onClick: speak,
          title: busy ? "合成中…" : speaking ? "停止朗读" : state === "ready" ? "点击播放" : "朗读这条回答",
          "aria-label": "朗读这条回答",
          disabled: !text,
        },
        busy ? "⏳" : speaking ? "⏹" : "🔊",
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
          ".dsh-voice-btn.is-ready{",
          "  color:#e5a03d;border-color:#e5a03d;opacity:1;",
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

      // Agent speech (voice_speak) renders as a playable strip / card inside
      // the tool row — keyed slot dispatched by the wire tool name.
      ctx.slots.inject("tool.call.toolview", () => ctx.slots.register(
        { name: "tool.call.toolview", key: "voice_speak", order: 30 },
        VoiceSpeakView,
      ));

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
            bustThresholdCache(); // Settings audio.* changed → next toolview re-reads live
          })
          .catch((e) => setState((s) => ({ ...s, saving: false, error: e.message })));
      };
      const setReadAloudVoice = (value) => {
        const draft = { ...state.draft, tts: { ...(state.draft.tts || {}) } };
        draft.tts.voice = value;
        setState((s) => ({ ...s, draft }));
      };
      const setReadAloudStyle = (value) => {
        const draft = { ...state.draft, tts: { ...(state.draft.tts || {}) } };
        draft.tts.style = value;
        setState((s) => ({ ...s, draft }));
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
        React.createElement("h3", null, "Voice (MiMo)"),
        React.createElement(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
          React.createElement("label", { htmlFor: "dsh-voice-readaloud", style: { fontSize: "13px" } }, "朗读音色 (🔊)"),
          React.createElement(
            "select",
            {
              id: "dsh-voice-readaloud",
              value: (state.draft.tts && state.draft.tts.voice) || "alloy",
              onChange: (e) => setReadAloudVoice(e.target.value),
            },
            Object.keys(state.draft.voiceMap || {}).map((name) =>
              React.createElement("option", { key: name, value: name }, name)),
          ),
          React.createElement("span", { style: { fontSize: "12px", opacity: 0.6 } },
            "The 🔊 button reads replies with this voice (resolved through the voice map below). Applies on the next click."),
        ),
        React.createElement(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
          React.createElement("label", { htmlFor: "dsh-voice-style", style: { fontSize: "13px" } }, "朗读语气 (🔊)"),
          React.createElement("input", {
            id: "dsh-voice-style",
            type: "text",
            value: (state.draft.tts && typeof state.draft.tts.style === "string") ? state.draft.tts.style : "温柔",
            onChange: (e) => setReadAloudStyle(e.target.value),
            placeholder: "温柔 / 沉稳 / 轻快，或导演式描述…",
            style: { minWidth: "220px", padding: "4px 8px", borderRadius: "6px", border: "1px solid rgba(128,128,128,.35)", background: "transparent", color: "inherit" },
          }),
          React.createElement("span", { style: { fontSize: "12px", opacity: 0.6 } },
            "Style applied to 🔊 and to voice_speak when no explicit style is passed (free text — a word like 温柔 or a full director-style paragraph)."),
        ),
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
                      ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"].map((v) =>
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
