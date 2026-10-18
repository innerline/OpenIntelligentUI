"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopilotChat, useAgent, useCopilotKit } from "@copilotkit/react-core/v2";
import { uuid } from "@/lib/uuid";
import { detectOwnerDevice, getOwnerDeviceSource, OWNER_DEVICE_CHANGED_EVENT, type OwnerDevice, type OwnerDeviceSource } from "@/lib/owner-device";
import { OwnerDeviceChip } from "@/components/cockpit/owner-device-chip";
import { isVisualPointer, publishVisual } from "@/lib/visual-pointer";
import { ReaderScrollView } from "@/components/chat/reader-scroll-view";
import { AnswerMarkdown } from "@/components/chat/answer-markdown";
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
const MESSAGE_VIEW = { assistantMessage: { markdownRenderer: AnswerMarkdown } };

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
  agentId: "honey" | "larry";
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
  // Read once per mount — survives tab discard via localStorage, so the
  // remounted page rejoins the SAME engine thread instead of orphaning it.
  const [threadId, setThreadId] = useState(() => loadThreadId(agentId));

  // Cross-device rejoin (kanban/cockpit-thread-continuity, 2026-10-18):
  // the localStorage pin is per BROWSER — phone and laptop each minted
  // their own thread and the owner's conversation scattered across them.
  // The adapter answers /thread/current with the persona's most recently
  // active thread; adopt it while this mount is still idle (no history
  // restored yet, no run in flight). Whatever thread spoke last IS the
  // anchor, so a device that drifts rejoins on its next mount and the
  // conversation converges to one thread without a mid-chat yank.
  useEffect(() => {
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
  }, [agent, agentId, threadId]);

  // History restore: after a remount the chat's message list is empty
  // (CopilotKit keeps threads in memory only), so pull the transcript the
  // adapter recorded for this thread. Guarded to never seed mid-run.
  // The LAST assistant turn's visual pointer (if the adapter recorded
  // one) republishes to the pointing sidebar — a remounted page shows
  // what the last answer pointed at, null meaning "pointed at nothing"
  // (never a stale older artifact).
  const restore = useCallback(() => {
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
  }, [agent, agentId, threadId]);

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
      agent.runAgent({ forwardedProps: { ...deviceTag } }).catch(() =>
        setError("The engine could not be reached. Check the adapter, then retry."),
      );
    },
    [agent, deviceTag],
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
    const subscription = agent.subscribe({
      onRunInitialized: () => setError(null),
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
        const raw = event?.result?.visual;
        publishVisual(agentId, isVisualPointer(raw) ? raw : null);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent, agentId]);

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
      </div>
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
