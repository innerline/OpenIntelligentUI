"use client";

import { CopilotChatView } from "@copilotkit/react-core/v2";
import type { ComponentProps } from "react";
import { useProviderKeys } from "./provider-keys";

/** Draft holder for the chat view. The key gate was retired 2026-10-29
 * (suite cockpit wiring P2): the runtime's default agent answers
 * server-side on the GLM lane, so submission is never held for
 * browser-supplied provider keys. Own keys stay optional via the
 * API-keys dialog (BYOK compat). */
function KeyGatedChatViewComponent(props: ComponentProps<typeof CopilotChatView>) {
  const { draft, setDraft } = useProviderKeys();
  return <CopilotChatView
    {...props}
    inputValue={draft}
    onInputChange={setDraft}
    onSubmitMessage={(value) => {
      setDraft("");
      props.onSubmitMessage?.(value);
    }}
    onSelectSuggestion={(suggestion, index) => {
      setDraft("");
      props.onSelectSuggestion?.(suggestion, index);
    }}
  />;
}

// Keep the compound-component slots expected by CopilotKit’s chatView contract.
export const KeyGatedChatView = Object.assign(KeyGatedChatViewComponent, CopilotChatView);
