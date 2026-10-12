"use client";

import { useEffect, useRef, useState } from "react";
import { CopilotChat, useAgent, useCopilotKit } from "@copilotkit/react-core/v2";
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

export function EngineChat({
  agentId,
  title,
  endpoint,
  welcome,
  placeholder,
}: {
  agentId: "honey" | "larry";
  title: string;
  endpoint: string;
  welcome: string;
  placeholder: string;
}) {
  const { agent } = useAgent({ agentId });
  const { copilotkit } = useCopilotKit();
  const statuses = useEngineStatuses();
  const status = statuses?.[agentId];
  const [error, setError] = useState<string | null>(null);
  const sentDeepLink = useRef(false);

  useEffect(() => {
    const subscription = agent.subscribe({
      onRunInitialized: () => setError(null),
      onRunFinishedEvent: () => setError(null),
    });
    return () => subscription.unsubscribe();
  }, [agent]);

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
    agent.addMessage({ id: crypto.randomUUID(), role: "user", content: q });
    copilotkit.runAgent({ agent }).catch(() =>
      setError("The engine could not be reached. Check the adapter, then retry."),
    );
  }, [agent, copilotkit]);

  return (
    <div className="cockpit-chat">
      <div className="cockpit-chat-head">
        <h1>{title}</h1>
        <span className="cockpit-chat-sub">{endpoint}</span>
      </div>
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
          autoScroll={false}
          scrollView={ReaderScrollView}
          messageView={{ assistantMessage: { markdownRenderer: AnswerMarkdown } }}
          onError={() =>
            setError("Something interrupted the answer. Try again or send another message.")
          }
          labels={{
            welcomeMessageText: welcome,
            chatInputPlaceholder: placeholder,
            chatDisclaimerText: "AI can make mistakes. Check important details.",
          }}
        />
      </div>
    </div>
  );
}
