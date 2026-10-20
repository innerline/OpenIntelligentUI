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
  getVoiceNote,
  playVoiceNote,
  requestVoiceNote,
  setTtsMode,
  subscribeSpeaking,
  subscribeTtsErrors,
  subscribeVoiceNote,
  TTS_ERROR_FADE_MS,
  HONEY_TTS_MODE_CHANGED_EVENT,
  TTS_MODES,
  type TtsError,
  type TtsMode,
  type VoiceNoteState,
} from "@/lib/honey-tts";

// Honey voice output on the cockpit chat surfaces (MWP kanban
// /device-input-matrix slice: "iPhone is using chat to TTS and STT").
// Four builds of on-device speechSynthesis stayed silent on the
// owner's phone — replies are now rendered SERVER-side (`say` on the
// Studio) and played here as voice notes. Pieces, all additive:
//   1. AssistantMessageWithSpeech — wraps the default assistant
//      message, keeping the app's markdown renderer, and rides the
//      voice-note chip inside each reply. Module-stable identity so
//      engine-chat's MESSAGE_VIEW never remounts chat internals.
//   2. VoiceNoteChip — per-reply ▶ play chip (auto mode's phone lane
//      and manual mode's 🔊 both publish state on the message id).
//   3. TtsModeChip — the persistent voice-output toggle (auto /
//      manual / off, localStorage honey-tts-mode), styled to the
//      device-chip grammar next to it in the chat head.
//   4. SpeakingChip — the visible "playing" state: a stop chip that
//      kills playback on tap. Renders nothing while silent.
//   5. TtsErrorChip — a voice failure, visible (never again silent).
//      Same chip grammar as the stop chip; fades after
//      TTS_ERROR_FADE_MS.

export function AssistantMessageWithSpeech(
  props: CopilotChatAssistantMessageProps,
) {
  const message = props.message;
  const messageId =
    message && typeof message.id === "string" ? message.id : null;
  const content =
    typeof message?.content === "string" ? message.content : null;
  return (
    <CopilotChatAssistantMessage
      {...props}
      markdownRenderer={AnswerMarkdown}
      // The toolbar renders the read-aloud button once an onReadAloud
      // exists; the button itself decides whether manual mode shows
      // it. Manual mode = render this reply on demand, then play —
      // the tap primed the shared element, so play survives the
      // async fetch.
      onReadAloud={() => {
        if (messageId && content && content.trim()) {
          void requestVoiceNote(messageId, content).then((state) => {
            if (state.status === "ready") playVoiceNote(state.url);
          });
        }
      }}
      readAloudButton={TtsReadAloudButton}
      // The voice-note chip rides the reply's own toolbar (CopilotKit
      // slot for extra items — the children render-prop would replace
      // the whole default layout).
      additionalToolbarItems={
        messageId ? <VoiceNoteChip messageId={messageId} /> : null
      }
    />
  );
}

// The voice-note chip on a reply: ▶ play (with duration when the
// browser hands it over cheaply), "rendering…" while the Studio's
// `say` runs, and "voice render failed" when it does not — never a
// silent failure. Renders nothing until a voice note exists for THIS
// message id, so auto mode's non-phone runs stay untouched.
function VoiceNoteChip({ messageId }: { messageId: string }) {
  const [note, setNote] = useState<VoiceNoteState | null>(() =>
    getVoiceNote(messageId),
  );
  useEffect(() => subscribeVoiceNote(messageId, setNote), [messageId]);
  // Duration if cheap: a metadata-only probe never plays audio.
  const [duration, setDuration] = useState<number | null>(null);
  const url = note?.status === "ready" ? note.url : null;
  useEffect(() => {
    if (!url || typeof Audio === "undefined") return;
    const probe = new Audio();
    try {
      probe.preload = "metadata";
      probe.onloadedmetadata = () => {
        if (Number.isFinite(probe.duration)) setDuration(probe.duration);
      };
      probe.src = url;
    } catch {
      // duration is a nicety, never load-bearing
    }
    return () => {
      probe.onloadedmetadata = null;
      try {
        probe.removeAttribute("src");
      } catch {
        // jsdom stubs may throw
      }
    };
  }, [url]);
  if (!note) return null;
  if (note.status === "failed") {
    return (
      <span className="tts-note-chip tts-note-failed" role="alert">
        voice render failed
      </span>
    );
  }
  if (note.status === "rendering") {
    return <span className="tts-note-chip">rendering voice…</span>;
  }
  const mm = duration === null ? null : Math.floor(duration / 60);
  const ss =
    duration === null ? null : String(Math.round(duration % 60)).padStart(2, "0");
  return (
    <button
      type="button"
      className="tts-note-chip tts-note-play"
      aria-label="Play voice note"
      title="Play Honey's reply as a voice note"
      onClick={() => playVoiceNote(note.url)}
    >
      ▶ voice note{mm !== null && ss !== null ? ` · ${mm}:${ss}` : ""}
    </button>
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

// A voice failure (render or playback): renders beside the stop chip
// in the same grammar, `voice error: <label>`, and fades after
// TTS_ERROR_FADE_MS. The render lane's own types get plain words —
// the owner reads "voice render failed", not a code.
export function TtsErrorChip() {
  const [error, setError] = useState<TtsError | null>(null);
  useEffect(() => {
    let fade: number | undefined;
    const unsubscribe = subscribeTtsErrors((e) => {
      setError(e);
      window.clearTimeout(fade);
      fade = window.setTimeout(() => setError(null), TTS_ERROR_FADE_MS);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(fade);
    };
  }, []);
  if (!error) return null;
  const label =
    error.type === "voice-render-failed"
      ? "voice render failed"
      : error.type === "voice-playback-failed"
        ? "voice note would not play"
        : error.type === "unknown" && error.message
          ? error.message
          : error.type;
  return (
    <span className="owner-device-chip-btn tts-error-chip" role="alert">
      voice error: {label}
    </span>
  );
}
