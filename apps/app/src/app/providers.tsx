"use client";

import { useEffect, useState } from "react";
import { CopilotKit } from "@copilotkit/react-core";
import { CopilotChatConfigurationProvider } from "@copilotkit/react-core/v2";
import { OPEN_GEN_UI_DESIGN_SKILL } from "@repo/design-system";
import { OPEN_GEN_UI_ACTIVITY_RENDERER } from "@/components/generative-ui/open-generative-ui";
import { SANDBOX_FUNCTIONS } from "@/lib/sandbox/sandbox-functions";
import { OpenGenUIPromptBridge } from "@/lib/sandbox/prompt-bridge";
import { detectOwnerDevice, getOwnerDeviceSource, OWNER_DEVICE_CHANGED_EVENT } from "@/lib/owner-device";
import { tableCatalog } from "@/components/generative-ui/table-catalog";
import { ProviderKeysProvider, useProviderKeys } from "@/components/chat/provider-keys";
import { ThemeProvider } from "@/hooks/use-theme";

const a2ui = { catalog: tableCatalog };

const renderActivityMessages = [OPEN_GEN_UI_ACTIVITY_RENDERER];
const openGenerativeUI = {
  sandboxFunctions: [...SANDBOX_FUNCTIONS],
  designSkill: OPEN_GEN_UI_DESIGN_SKILL,
};

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ProviderKeysProvider>
        <ChatProviders>{children}</ChatProviders>
      </ProviderKeysProvider>
    </ThemeProvider>
  );
}

function ChatProviders({ children }: { children: React.ReactNode }) {
  const { headers, session } = useProviderKeys();
  // Device input matrix (kanban/device-input-matrix): the provider's
  // `properties` ride every run the core fires (typed input, suggestions)
  // as forwardedProps — the adapters resolve the device from them.
  // Classification is SERVER-side (owner hit #3, 2026-10-18): the
  // runtime edge stamps the browser's real peer address + UA on every
  // proxied run, and this tag is SOURCED — a chip pin ("pin") beats
  // every server signal, the heuristic guess ("heuristic") is only a
  // last-resort fallback when the server could not classify. The
  // owner's chip pin re-reads here, so core-driven runs retag too.
  const [properties, setProperties] = useState(() => ({
    device: detectOwnerDevice(),
    deviceSource: getOwnerDeviceSource(),
  }));
  useEffect(() => {
    const onChange = () =>
      setProperties({
        device: detectOwnerDevice(),
        deviceSource: getOwnerDeviceSource(),
      });
    window.addEventListener(OWNER_DEVICE_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(OWNER_DEVICE_CHANGED_EVENT, onChange);
  }, []);
  return (
    <CopilotKit
      key={session}
      headers={headers}
      runtimeUrl="/api/copilotkit"
      properties={properties}
      showDevConsole={false}
      enableInspector={false}
      renderActivityMessages={renderActivityMessages}
      openGenerativeUI={openGenerativeUI}
      a2ui={a2ui}
    >
      <CopilotChatConfigurationProvider>
        <OpenGenUIPromptBridge />
        {children}
      </CopilotChatConfigurationProvider>
    </CopilotKit>
  );
}
