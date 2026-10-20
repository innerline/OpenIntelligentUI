"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopilotChat, useAgent, useCopilotKit, CopilotChatAssistantMessage } from "@copilotkit/react-core/v2";
import { uuid } from "@/lib/uuid";
import { detectOwnerDevice, getOwnerDeviceSource, OWNER_DEVICE_CHANGED_EVENT, type OwnerDevice, type OwnerDeviceSource } from "@/lib/owner-device";
import { OwnerDeviceChip } from "@/components/cockpit/owner-device-chip";
import { AssistantMessageWithSpeech, SpeakingChip, TtsErrorChip, TtsModeChip } from "@/components/cockpit/tts-speech";
import { cancelSpeech, maybeAutoVoiceNote, primeVoiceAudio } from "@/lib/honey-tts";
import { isVisualPointer, publishVisual } from "@/lib/visual-pointer";
import { ReaderScrollView } from "@/components/chat/reader-scroll-view";
import { useEngineStatuses } from "./engine-status";
import "./cockpit.css";

// Cockpit chat surface for one AG-UI engine (Honey :8126 / Larry :8127).
// The engine holds its own model keys, so this surface is NOT gated on
// provider keys like the default chat — it talks to a named runtime
// agent (see lib/copilotkit-runtime-options.ts) that proxies the run to
// the adapter over the AG-UI wire.
//
// Deep links: /cockpit/honey?q=<text> sends <text> as the first message
// (used by the Visuals tab's "ask Honey about this node" hand-off).

// Stable prop identities for CopilotChat — inline literals re-created on
// every render risk remounting chat internals (draft input included) on
// unrelated re-renders (status polls). Keep these at module level.
// The assistant slot is Honey's TTS wrapper (kanban/device-input-matrix
// slice 3): manual mode's read-aloud button rides every reply. The cast
// bridges a slot type that only models the DEFAULT component's statics —
// resolveSlotComponent accepts any component at runtime.
const MESSAGE_VIEW = {
  assistantMessage: AssistantMessageWithSpeech,
} as { assistantMessage: typeof CopilotChatAssistantMessage };

// owner 2026-10-17: tab switch in Safari discarded the page; CopilotKit
// minted a fresh thread per mount and the engine session orphaned —
// pin the thread per browser and restore history on remount.
function loadThreadId(agentId: string): string {
  const key = "cockpit.thread." + agentId;
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const minted = "web-" + uuid();
    window.localStorage.setItem(key, minted);
    return minted;
  } catch {
    // Storage blocked (private mode): unpinned but usable for this mount.
    return "web-" + uuid();
  }
}

// One restored turn from the adapter's GET /threads/{id}.
type TranscriptMessage = {
  role: string;
  content: string;
  visual?: unknown; // VISUAL pointer the adapter parsed off this reply
};

export function EngineChat({
  agentId,
  title,
  endpoint,
  welcome,
  placeholder,
  notice,
}: {
  agentId: "honey" | "larry" | "pi";
  title: string;
  endpoint: string;
  welcome: string;
  placeholder: string;
  notice?: string;
}) {
  const { agent } = useAgent({ agentId });
  const { copilotkit } = useCopilotKit();
  const statuses = useEngineStatuses();
  const status = statuses?.[agentId];
  const [error, setError] = useState<string | null>(null);
  const sentDeepLink = useRef(false);
  // Device tag (kanban/device-input-matrix): this send path calls
  // agent.runAgent() DIRECTLY, which bypasses the provider's
  // `properties` merge — so the tag is passed explicitly here too.
  // Classification is SERVER-side (owner hit #3, 2026-10-18): the
  // runtime edge stamps the browser's real peer address + UA on every
  // proxied run; this tag is SOURCED — the chip's pin ("pin") beats
  // every server signal, the heuristic guess ("heuristic") is only a
  // last-resort fallback when the server could not classify. The
  // header's device chip re-pins the truth and this listener re-reads
  // it, so the NEXT run carries the new tag.
  const [deviceTag, setDeviceTag] = useState<{
    device: OwnerDevice;
    deviceSource: OwnerDeviceSource;
  }>(() => ({ device: detectOwnerDevice(), deviceSource: getOwnerDeviceSource() }));
  useEffect(() => {
    const onChange = () =>
      setDeviceTag({
        device: detectOwnerDevice(),
        deviceSource: getOwnerDeviceSource(),
      });
    window.addEventListener(OWNER_DEVICE_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(OWNER_DEVICE_CHANGED_EVENT, onChange);
  }, []);
  // The RUN_FINISHED speech lane below must read the tag the run
  // CARRIED, not a stale closure — the agent subscription below does
  // not re-subscribe on device changes, so it reads through this ref.
  const deviceRef = useRef<OwnerDevice>(deviceTag.device);
  useEffect(() => {
    deviceRef.current = deviceTag.device;
  }, [deviceTag.device]);
  // iPhone voice (kanban/device-input-matrix): iOS blocks audio
  // playback outside a user gesture — prime the shared Audio element
  // on the first tap anywhere in the page (the send-button tap
  // counts) with digital silence, so the reply's voice note can
  // auto-play later. Capture phase, before React handlers.
  useEffect(() => {
    const onPointerDown = () => primeVoiceAudio();
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      });
  }, []);
  // iOS suspends audio when the tab hides — stop playback and keep
  // the speaking state honest instead of leaving a dead stop chip.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") cancelSpeech();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () =>
      document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  // Test-mode isolation (unified-honey K1 go-live gate, 2026-10-19):
  // ?test=1 mounts the SANDBOX lane. The adapter quarantines flagged runs
  // (forwardedProps.testMode, and any test- namespace thread even without
  // the flag), but this mount also keeps its SIDE clean: it never adopts
  // the owner's anchor, never restores his history, never touches the
  // localStorage pin — it mints a memory-only test- thread per mount and
  // wears a visible TEST banner.
  const isTestMode = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get("test") === "1";
    } catch {
      return false;
    }
  }, []);
  // Read once per mount — survives tab discard via localStorage, so the
  // remounted page rejoins the SAME engine thread instead of orphaning it.
  // Test mode: memory-only mint (never pinned, never restored from).
  const [threadId, setThreadId] = useState(() =>
    isTestMode ? "test-" + uuid() : loadThreadId(agentId),
  );
  // The speech lane's second ear (iPhone voice slice 3): CopilotChat
  // renders and submits through a per-thread CLONE of the registry
  // agent (its own useAgent(threadId) lane — verified: a typed send's
  // RUN_FINISHED never reaches a registry-only subscriber). The owner's
  // typed sends ride the clone; this surface's own sends (deep link,
  // ask-honey hand-off) ride the registry agent. `updates: []` keeps
  // this hook's internal re-render machinery off — we only subscribe.
  const { agent: threadAgent } = useAgent({ agentId, threadId, updates: [] });

  // Cross-device rejoin (kanban/cockpit-thread-continuity, 2026-10-18):
  // the localStorage pin is per BROWSER — phone and laptop each minted
  // their own thread and the owner's conversation scattered across them.
  // The adapter answers /thread/current with the persona's most recently
  // active thread; adopt it while this mount is still idle (no history
  // restored yet, no run in flight). Whatever thread spoke last IS the
  // anchor, so a device that drifts rejoins on its next mount and the
  // conversation converges to one thread without a mid-chat yank.
  useEffect(() => {
    if (isTestMode) return; // sandbox lane never adopts the owner's anchor
    let cancelled = false;
    fetch(`/api/cockpit/thread-current?agent=${encodeURIComponent(agentId)}`)
      .then((res) => (res.ok ? res.json() : Promise.resolve({ threadId: null })))
      .then((body: { threadId?: string | null }) => {
        if (cancelled) return;
        const anchor = typeof body.threadId === "string" ? body.threadId : null;
        if (!anchor || anchor === threadId) return;
        if (agent.messages.length > 0 || agent.isRunning) return;
        setThreadId(anchor);
        try {
          window.localStorage.setItem("cockpit.thread." + agentId, anchor);
        } catch {
          // Storage blocked — this mount still rejoins the anchor.
        }
      })
      .catch(() => {}); // best-effort: the pin keeps the chat working
    return () => {
      cancelled = true;
    };
  }, [agent, agentId, threadId, isTestMode]);

  // History restore: after a remount the chat's message list is empty
  // (CopilotKit keeps threads in memory only), so pull the transcript the
  // adapter recorded for this thread. Guarded to never seed mid-run.
  // The LAST assistant turn's visual pointer (if the adapter recorded
  // one) republishes to the pointing sidebar — a remounted page shows
  // what the last answer pointed at, null meaning "pointed at nothing"
  // (never a stale older artifact).
  const restore = useCallback(() => {
    if (isTestMode) return; // sandbox lane: no owner history, ever
    if (agent.messages.length > 0 || agent.isRunning) return;
    fetch(
      `/api/cockpit/thread-messages?agent=${encodeURIComponent(agentId)}&thread=${encodeURIComponent(threadId)}`,
    )
      .then((res) => (res.ok ? res.json() : Promise.resolve({ messages: [] })))
      .then((body: { messages?: TranscriptMessage[] }) => {
        const turns = body.messages ?? [];
        if (turns.length === 0) return;
        if (agent.messages.length > 0 || agent.isRunning) return; // re-check after await
        const mapped: { id: string; role: "user" | "assistant"; content: string }[] = [];
        turns.forEach((m, idx) => {
          if (m.role !== "user" && m.role !== "assistant") return;
          mapped.push({ id: `t${idx}`, role: m.role, content: m.content });
        });
        if (mapped.length > 0) agent.setMessages(mapped);
        for (let i = turns.length - 1; i >= 0; i--) {
          if (turns[i].role === "assistant") {
            const carried: unknown = turns[i].visual;
            publishVisual(agentId, isVisualPointer(carried) ? carried : null);
            break;
          }
        }
      })
      .catch(() => {}); // best-effort: the chat works without history
  }, [agent, agentId, threadId, isTestMode]);

  useEffect(() => {
    restore();
  }, [restore]);

  // Safari discards this tab in the background; on return, the page is
  // fresh again — same cheap guarded restore as on mount.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") restore();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [restore]);

  // One send path for deep links and the Visuals sidebar hand-off — the
  // human path (addMessage + runAgent), live-proven 2026-10-12.
  const send = useCallback(
    (text: string) => {
      if (agent.isRunning) return;
      agent.addMessage({ id: uuid(), role: "user", content: text });
      agent
        .runAgent({
          forwardedProps: {
            ...deviceTag,
            // Test-mode isolation (unified-honey K1 gate): the flag puts
            // the run in the adapter's sandbox lane — the owner's thread,
            // session and transcript are unreachable from it.
            ...(isTestMode ? { testMode: true } : {}),
          },
        })
        .catch(() =>
          setError("The engine could not be reached. Check the adapter, then retry."),
        );
    },
    [agent, deviceTag, isTestMode],
  );

  // "Ask Honey about this node" from the docked Visuals sidebar (same
  // page, no navigation): the plex panel dispatches, this surface sends.
  useEffect(() => {
    if (agentId !== "honey") return;
    const handler = (e: Event) => send((e as CustomEvent<string>).detail);
    window.addEventListener("cockpit-ask-honey", handler);
    return () => window.removeEventListener("cockpit-ask-honey", handler);
  }, [agentId, send]);

  useEffect(() => {
    // The last assistant text THIS run streamed — the iPhone voice lane
    // speaks only replies the run produced (TEXT_MESSAGE deltas), never
    // history a connect/restore lane replays as a snapshot.
    const streamedReply = { id: null as string | null, text: null as string | null };
    // Tagged so the registry subscription and the clone subscription can
    // tell each other apart: a per-thread clone INHERITS copies of the
    // registry agent's subscribers at clone time (AbstractAgent.clone),
    // so an inherited copy must not be double-subscribed.
    const SPEECH_SUB_TAG = "__honeyTtsSpeech";
    type SpeechSubscriber = Parameters<typeof agent.subscribe>[0] & {
      [SPEECH_SUB_TAG]?: boolean;
    };
    const handlers: SpeechSubscriber = {
      // A new run cancels any reply still being spoken — Honey never
      // talks over herself (iPhone voice slice).
      onRunInitialized: () => {
        setError(null);
        cancelSpeech();
      },
      onTextMessageStartEvent: ({
        event,
      }: {
        event?: { messageId?: string; role?: string };
      }) => {
        // only assistant text streams over AG-UI — track its id
        if (event?.role === "assistant" && typeof event.messageId === "string") {
          streamedReply.id = event.messageId;
        }
      },
      onTextMessageEndEvent: ({
        event,
        textMessageBuffer,
      }: {
        event?: { messageId?: string };
        textMessageBuffer?: string;
      }) => {
        // textMessageBuffer is the completed text of the ended message
        if (
          typeof event?.messageId === "string" &&
          event.messageId === streamedReply.id &&
          typeof textMessageBuffer === "string" &&
          textMessageBuffer.trim().length > 0
        ) {
          streamedReply.text = textMessageBuffer;
        }
      },
      // Visual pointer slice (kanban/device-input-matrix slice 2): the
      // adapter strips the VISUAL machine line from the reply and parks
      // the parsed pointer on RUN_FINISHED's result — AG-UI's run-result
      // metadata lane, the engine->cockpit mirror of the device tag.
      // null = this reply pointed at nothing; the sidebar must not
      // linger on an older artifact. Agent-level subscription, so BOTH
      // send paths (provider properties + the direct runAgent) report.
      onRunFinishedEvent: ({
        event,
      }: {
        event: { result?: { visual?: unknown } };
      }) => {
        setError(null);
        // Connect/restore lanes (no streamed assistant text) publish and
        // voice nothing — their RUN_FINISHED would otherwise wipe the
        // pointer an earlier reply left in the sidebar.
        const ran = streamedReply.id !== null;
        const replyId = streamedReply.id;
        streamedReply.id = null;
        const spoken = streamedReply.text;
        streamedReply.text = null;
        if (!ran) return;
        // Visual pointer slice (kanban/device-input-matrix slice 2): the
        // adapter strips the VISUAL machine line from the reply and parks
        // the parsed pointer on RUN_FINISHED's result — AG-UI's run-result
        // metadata lane, the engine->cockpit mirror of the device tag.
        // null = this reply pointed at nothing; the sidebar must not
        // linger on an older artifact. Agent-level subscription, so BOTH
        // send paths (provider properties + the direct runAgent) report.
        const raw = event?.result?.visual;
        publishVisual(agentId, isVisualPointer(raw) ? raw : null);
        // iPhone voice: in auto mode a phone-tagged run's completed
        // reply is rendered SERVER-side by the Studio's `say` CLI and
        // played back as a voice note (the Web Speech lane was removed
        // after four silent builds) — the reply this run streamed, if
        // any. The message id keys the ▶ chip on the reply itself.
        if (spoken) maybeAutoVoiceNote(spoken, deviceRef.current, replyId);
      },
    };
    handlers[SPEECH_SUB_TAG] = true;
    const subscriptions = [agent.subscribe(handlers)];
    if (
      threadAgent !== agent &&
      !threadAgent.subscribers.some(
        (s) => (s as SpeechSubscriber)[SPEECH_SUB_TAG] === true,
      )
    ) {
      subscriptions.push(threadAgent.subscribe(handlers));
    }
    return () => {
      for (const s of subscriptions) s.unsubscribe();
    };
  }, [agent, threadAgent, agentId]);

  // ?q= deep link — send once, then strip the param so a refresh asks
  // nothing. Same path a human takes (addMessage + runAgent), so thread
  // state and rendering are the app's own.
  useEffect(() => {
    if (sentDeepLink.current || agent.isRunning) return;
    const q = new URLSearchParams(window.location.search).get("q");
    if (!q) return;
    sentDeepLink.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("q");
    window.history.replaceState({}, "", url);
    send(q);
  }, [agent, copilotkit, send]);

  // Stable labels/onError for the same reason as MESSAGE_VIEW — inline
  // literals re-created per render risk remounting chat internals.
  const labels = useMemo(
    () => ({
      welcomeMessageText: welcome,
      chatInputPlaceholder: placeholder,
      chatDisclaimerText: "AI can make mistakes. Check important details.",
    }),
    [welcome, placeholder],
  );
  const onError = useCallback(
    () => setError("Something interrupted the answer. Try again or send another message."),
    [],
  );

  return (
    <div className="cockpit-chat">
      <div className="cockpit-chat-head">
        <h1>{title}</h1>
        <span className="cockpit-chat-sub">{endpoint}</span>
        {/* Device chip (owner refinement 2026-10-18): shows the tag being
            sent; click to pin phone/ipad/laptop/studio — the pin beats the
            loopback heuristic that misfired studio-at-laptop. */}
        <OwnerDeviceChip />
        {/* Voice output (iPhone contract, slice 3): mode toggle + the
            stop chip that appears only while a reply is being spoken.
            TtsErrorChip (2026-10-20): a voice failure is VISIBLE — the
            phone incident must never repeat silently. */}
        <TtsModeChip />
        <SpeakingChip />
        <TtsErrorChip />
      </div>
      {isTestMode && (
        <div className="cockpit-chat-banner test" role="status">
          <span className="dash-dot dot-off" aria-hidden />
          TEST MODE — sandbox thread; the owner&apos;s conversation is untouched.
        </div>
      )}
      {notice && (
        <div className="cockpit-chat-banner warn" role="note">
          <span className="dash-dot dot-off" aria-hidden />
          {notice}
        </div>
      )}
      {status && !status.ok && (
        <div className="cockpit-chat-banner warn" role="status">
          <span className="dash-dot dot-off" aria-hidden />
          engine not answering right now ({status.detail}) — messages will fail
          until the adapter is back.
        </div>
      )}
      {error && (
        <div className="chat-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      <div className="chat-content">
        <CopilotChat
          agentId={agentId}
          threadId={threadId}
          autoScroll={false}
          scrollView={ReaderScrollView}
          messageView={MESSAGE_VIEW}
          onError={onError}
          labels={labels}
        />
      </div>
    </div>
  );
}
