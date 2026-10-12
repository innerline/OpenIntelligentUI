"use client";

import { CopilotChatAssistantMessage } from "@copilotkit/react-core/v2";

// The viewer's read-only body — the SAME markdown pipeline the chat
// answers use (Streamdown under the assistant-message renderer slot),
// so a card reads exactly like the answer that cited it. The chat's
// reveal-on-scroll animation is deliberately not applied: this is a
// finished document, not a streaming answer.
export function VaultDoc({ content, canvas }: { content: string; canvas: boolean }) {
  if (canvas) {
    // .canvas is JSON, not markdown — show it verbatim, still read-only.
    return (
      <pre className="vault-canvas">
        <code>{content}</code>
      </pre>
    );
  }
  return <CopilotChatAssistantMessage.MarkdownRenderer content={content} />;
}
