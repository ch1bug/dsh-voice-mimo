/**
 * dsh-voice — browser half.
 *
 * Adds two controls to the DeepSeek Harness Web GUI:
 *
 *  • 🎤 at `conversation.input.left`  — speech input. Requests the microphone
 *    explicitly, then transcribes via the Web Speech API (SpeechRecognition)
 *    and writes the transcript into the composer draft via `inputActions.setDraft`.
 *  • 🔊 at `conversation.chat.assistant-actions` — read one assistant reply
 *    aloud via the Web Speech API (speechSynthesis).
 *
 * Both are pure-browser (zero API key), so a text-only model like DeepSeek
 * gets a voice loop without any backend: mic → text → model → text → speaker.
 *
 * Plain JavaScript, no JSX — build elements with React.createElement.
 */

window.__ModuleLoader__.load({
  id: "dsh-voice",
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

    const getRecognition = () =>
      typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition || null);

    // ──────────────────────────────────────────────────────────────────────────
    // Mic button — getUserMedia (permission) → SpeechRecognition → draft
    // ──────────────────────────────────────────────────────────────────────────
    function MicButton(props) {
      const { useInput, inputActions } = props;
      const [listening, setListening] = useState(false);
      const [error, setError] = useState("");
      const recRef = useRef(null);

      useEffect(() => {
        return () => {
          if (recRef.current) {
            try {
              recRef.current.abort();
            } catch (_) {
              /* ignore */
            }
          }
        };
      }, []);

      const start = async () => {
        if (!inputActions) return;
        setError("");

        const SR = getRecognition();
        if (!SR) {
          setError("浏览器不支持语音识别（请用 Chrome / Edge）");
          console.error("[dsh-voice] SpeechRecognition is not available in this browser");
          return;
        }

        // 1. Explicitly request microphone permission first. This avoids the
        //    common Chrome race where SpeechRecognition.start() errors out
        //    immediately because the permission prompt is still pending.
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
        } catch (err) {
          const name = err && err.name ? err.name : "UnknownError";
          if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
            setError("麦克风权限被拒绝，请在浏览器地址栏允许麦克风");
          } else {
            setError("无法访问麦克风：" + name);
          }
          console.error("[dsh-voice] getUserMedia failed:", name, err);
          return;
        }

        let rec;
        try {
          rec = new SR();
        } catch (err) {
          setError("语音识别初始化失败");
          console.error("[dsh-voice] new SpeechRecognition failed:", err);
          return;
        }

        if (STT_LANG) rec.lang = STT_LANG;
        rec.interimResults = false;
        rec.continuous = false;
        rec.maxAlternatives = 1;

        rec.onresult = (event) => {
          let text = "";
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const r = event.results[i] && event.results[i][0];
            if (r) text += r.transcript;
          }
          if (text) {
            const draft = (typeof useInput === "function" && useInput() ? useInput().draft : "") || "";
            const sep = draft && !/[\s\u3000]$/.test(draft) ? " " : "";
            inputActions.setDraft(draft + sep + text);
          }
          setListening(false);
          setError("");
        };

        rec.onerror = (event) => {
          const code = event && event.error ? event.error : "unknown";
          setListening(false);
          setError("识别出错：" + code);
          console.error("[dsh-voice] SpeechRecognition error:", code);
        };

        rec.onend = () => {
          setListening(false);
        };

        recRef.current = rec;
        setListening(true);
        try {
          rec.start();
        } catch (err) {
          setListening(false);
          setError("识别启动失败：" + (err && err.message ? err.message : "unknown"));
          console.error("[dsh-voice] SpeechRecognition.start failed:", err);
        }
      };

      const title = error
        ? error
        : listening
          ? "正在聆听，点击停止"
          : "语音输入";
      return React.createElement(
        "button",
        {
          type: "button",
          className: "dsh-voice-btn dsh-voice-mic" + (listening ? " is-listening" : "") + (error ? " is-error" : ""),
          onClick: start,
          title,
          "aria-label": title,
          disabled: !inputActions,
        },
        listening ? "●" : error ? "⚠️" : "🎤",
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
        if (!session || !Array.isArray(session.nodes)) {
          if (!session) console.warn("[dsh-voice] useSession returned nothing — cannot read message text");
          return "";
        }
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
        // Warm the voice list once — some browsers need getVoices() called
        // before speechSynthesis will actually speak.
        if (typeof window !== "undefined" && window.speechSynthesis) {
          window.speechSynthesis.getVoices();
        }
        return () => {
          if (typeof window !== "undefined" && window.speechSynthesis) {
            window.speechSynthesis.cancel();
          }
        };
      }, []);

      const pickVoice = () => {
        const synth = window.speechSynthesis;
        if (!synth) return null;
        const voices = synth.getVoices();
        if (!voices.length) return null;
        if (TTS_LANG) {
          const want = TTS_LANG.toLowerCase();
          const match = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(want));
          if (match) return match;
        }
        return voices.find((v) => v.default) || voices[0];
      };

      const speak = () => {
        if (!text || !window.speechSynthesis) return;
        const synth = window.speechSynthesis;
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        if (TTS_LANG) u.lang = TTS_LANG;
        u.rate = TTS_RATE;
        u.pitch = TTS_PITCH;
        const voice = pickVoice();
        if (voice) u.voice = voice;
        u.onend = () => setSpeaking(false);
        u.onerror = (event) => {
          console.error("[dsh-voice] speechSynthesis error:", event && event.error);
          setSpeaking(false);
        };
        setSpeaking(true);
        synth.speak(u);
      };

      return React.createElement(
        "button",
        {
          type: "button",
          className: "dsh-voice-btn dsh-voice-speaker" + (speaking ? " is-speaking" : ""),
          onClick: speak,
          title: speaking ? "停止朗读" : text ? "朗读这条回答" : "没有可朗读的文本",
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
          ".dsh-voice-btn:disabled{opacity:.35;cursor:default}",
          ".dsh-voice-btn.is-listening,.dsh-voice-btn.is-speaking{",
          "  color:#e5484d;border-color:#e5484d;opacity:1;",
          "}",
          ".dsh-voice-btn.is-error{color:#f59e0b;border-color:#f59e0b;opacity:1}",
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
        return () => dispose();
      });

      ctx.slots.inject("conversation.chat.assistant-actions", () => {
        const dispose = ctx.slots.register(
          { name: "conversation.chat.assistant-actions", id: "dsh-voice-speaker", order: 30 },
          SpeakerButton,
        );
        return () => dispose();
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
