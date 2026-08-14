/**
 * dsh-voice — browser half.
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

    // ──────────────────────────────────────────────────────────────────────────
    // Mic button — SpeechRecognition → composer draft
    // ──────────────────────────────────────────────────────────────────────────
    function MicButton(props) {
      const { useInput, inputActions } = props;
      const [listening, setListening] = useState(false);
      const recRef = useRef(null);

      useEffect(() => {
        return () => {
          if (recRef.current) {
            try {
              recRef.current.stop();
            } catch (_) {
              /* ignore */
            }
          }
        };
      }, []);

      const supported = () =>
        typeof window !== "undefined" &&
        (window.SpeechRecognition || window.webkitSpeechRecognition);

      const start = () => {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR || !inputActions) return;

        let rec;
        try {
          rec = new SR();
        } catch (_) {
          return;
        }
        rec.lang = STT_LANG;
        rec.interimResults = false;
        rec.continuous = false;
        rec.maxAlternatives = 1;

        rec.onresult = (event) => {
          let text = "";
          for (let i = event.resultIndex; i < event.results.length; i++) {
            text += event.results[i][0].transcript;
          }
          if (text) {
            const draft = (useInput && useInput().draft) || "";
            const sep = draft && !/[\s\u3000]$/.test(draft) ? " " : "";
            inputActions.setDraft(draft + sep + text);
          }
        };
        rec.onerror = () => setListening(false);
        rec.onend = () => setListening(false);

        recRef.current = rec;
        setListening(true);
        try {
          rec.start();
        } catch (_) {
          setListening(false);
        }
      };

      return React.createElement(
        "button",
        {
          type: "button",
          className: "dsh-voice-btn dsh-voice-mic" + (listening ? " is-listening" : ""),
          onClick: start,
          title: listening ? "正在聆听，点击停止" : "语音输入",
          "aria-label": "语音输入",
          disabled: !supported() || !inputActions,
        },
        listening ? "●" : "🎤",
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
