import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import type { CopilotChatView } from "@copilotkit/react-core/v2";
import { ProviderKeysProvider } from "./provider-keys";
import { KeyGatedChatView } from "./key-gated-chat-view";

vi.mock("@copilotkit/react-core/v2", () => ({
  CopilotChatView: (props: ComponentProps<typeof CopilotChatView>) => <>
    <input aria-label="Message" value={props.inputValue} onChange={(event) => props.onInputChange?.(event.target.value)} />
    <button onClick={() => props.onSubmitMessage?.(props.inputValue ?? "")}>Send</button>
    <button onClick={() => props.onSelectSuggestion?.({ title: "Example", message: "Explain flight", isLoading: false }, 0)}>Example</button>
  </>,
}));
const submit = vi.fn();
const select = vi.fn();
function Harness() {
  return <KeyGatedChatView onSubmitMessage={submit} onSelectSuggestion={select} />;
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// Vendor routing retired 2026-10-29 (suite cockpit wiring P2): the key
// gate is gone — submission flows straight through to the default agent
// (the server's GLM lane) with no browser-supplied keys at any point.
it("sends immediately without keys — no gate, no dialog, draft clears", () => {
  render(<ProviderKeysProvider><Harness /></ProviderKeysProvider>);
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Show a map" } });
  fireEvent.click(screen.getByText("Send"));
  expect(submit).toHaveBeenCalledExactlyOnceWith("Show a map");
  expect(screen.getByLabelText("Message")).toHaveValue("");
});

it("example prompts submit without keys and clear the draft", () => {
  render(<ProviderKeysProvider><Harness /></ProviderKeysProvider>);
  fireEvent.click(screen.getByText("Example"));
  expect(select).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Message")).toHaveValue("");
});
