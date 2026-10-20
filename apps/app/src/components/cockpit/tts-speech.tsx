"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import {
  CopilotChatAssistantMessage,
  type CopilotChatAssistantMessageProps,
} from "@copilotkit/react-core/v2";
import { AnswerMarkdown } from "@/components/chat/answer-markdown";
import {
  cancelSpeech,
  getTtsMode,
  setTtsMode,
  speakReply,
  subscribeSpeaking,
  HONEY_TTS_MODE_CHANGED_EVENT,
  TTS_MODES,
  type TtsMode,
} from "@/lib/honey-tts";

// Honey TTS on the cockpit chat surfaces (MWP kanban/device-input-matrix
// slice 3: "iPhone is using chat to TTS and STT"). Three pieces live
// here, all additive:
//   1. AssistantMessageWithSpeech — wraps the default assistant message
//      with the read-aloud slot (visible only in manual mode) while
//      keeping the app's markdown renderer. Module-stable identity so
//      engine-chat's MESSAGE_VIEW never remounts chat internals.
//   2. TtsModeChip — the persistent voice-output toggle (auto / manual
//      / off, localStorage honey-tts-mode), styled to the device-chip
//      grammar next to it in the chat head.
//   3. SpeakingChip — the visible "speaking" state: a stop chip that
//      kills playback on tap. Renders nothing while silent.

export function AssistantMessageWithSpeech(
  props: CopilotChatAssistantMessageProps,
) {
  return (
    <CopilotChatAssistantMessage
      {...props}
      markdownRenderer={AnswerMarkdown}
      // The toolbar renders the read-aloud button once an onReadAloud
      // exists; the button itself decides whether manual mode shows it.
      onReadAloud={() => {
        const content = props.message?.content;
        if (typeof content === "string" && content.trim()) {
          speakReply(content);
        }
      }}
      readAloudButton={TtsReadAloudButton}
    />
  );
}

// The play button on every assistant message — manual mode's surface,
// on ANY device. Auto mode stays hands-free (phone speaks by itself);
// off mode shows nothing. Each instance tracks the mode so the whole
// message list flips live when the chip changes it.
function TtsReadAloudButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const [mode, setMode] = useState<TtsMode>(() => getTtsMode());
  useEffect(() => {
    const onChange = () => setMode(getTtsMode());
    window.addEventListener(HONEY_TTS_MODE_CHANGED_EVENT, onChange);
    return () =>
      window.removeEventListener(HONEY_TTS_MODE_CHANGED_EVENT, onChange);
  }, []);
  if (mode !== "manual") return null;
  const { onClick, ...rest } = props;
  return (
    <button
      type="button"
      className="tts-play-btn"
      aria-label="Read reply aloud"
      title="Read this reply aloud"
      onClick={onClick}
      {...rest}
    >
      🔊
    </button>
  );
}

const TTS_MODE_LABELS: Record<TtsMode, string> = {
  auto: "auto — speak replies on the phone",
  manual: "manual — play button on every reply",
  off: "off — never speak",
};

// Voice-output toggle, same chip grammar as the owner device chip
// beside it: shows the active mode, click for the three modes, pin
// persists at honey-tts-mode.
export function TtsModeChip() {
  const [mode, setMode] = useState<TtsMode>(() => getTtsMode());
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onChange = () => setMode(getTtsMode());
    window.addEventListener(HONEY_TTS_MODE_CHANGED_EVENT, onChange);
    return () =>
      window.removeEventListener(HONEY_TTS_MODE_CHANGED_EVENT, onChange);
  }, []);

  // Close on outside press or Escape — a picker, not a modal (same as
  // the device chip).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="owner-device-chip tts-chip" ref={rootRef}>
      <button
        type="button"
        className="owner-device-chip-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Voice output: ${mode}`}
        title="How Honey's replies are spoken on this device"
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={
            mode === "off" ? "owner-device-dot" : "owner-device-dot pinned"
          }
          aria-hidden
        />
        voice {mode}
      </button>
      {open && (
        <div className="owner-device-menu" role="menu" aria-label="Voice output mode">
          {TTS_MODES.map((m) => (
            <button
              type="button"
              key={m}
              role="menuitemradio"
              aria-checked={mode === m}
              className="owner-device-option"
              onClick={() => {
                setTtsMode(m);
                setOpen(false);
              }}
            >
              <span className="owner-device-mark" aria-hidden>
                {mode === m ? "•" : ""}
              </span>
              {TTS_MODE_LABELS[m]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The visible speaking state: while a reply is being spoken, a stop
// chip sits in the chat head — one tap kills playback immediately.
export function SpeakingChip() {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => subscribeSpeaking(setSpeaking), []);
  if (!speaking) return null;
  return (
    <button
      type="button"
      className="owner-device-chip-btn tts-stop-btn"
      aria-label="Stop speaking"
      title="Stop the spoken reply"
      onClick={() => cancelSpeech()}
    >
      🔊 stop
    </button>
  );
}
