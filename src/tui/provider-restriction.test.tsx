import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { describeProviderRestriction, makeProviderPolicy } from "../llm/provider-policy.js";
import { reduceTuiState } from "./agent-event-reducer.js";
import { PromptMetaBar } from "./components/prompt-meta-bar.js";
import { formatTuiStatus } from "./status-snapshot-tui.js";
import { createInitialTuiState, type TuiSessionInfo } from "./tui-state.js";

/** Issue #33 group C: the TUI shows a session's provider restriction. */
const restriction = describeProviderRestriction(
  makeProviderPolicy({ key: "/work/secret", allowedProviders: ["local-llama"], matchedDir: "/work/secret" }),
)!;
const tainted = describeProviderRestriction(
  makeProviderPolicy({ key: "/work/secret", allowedProviders: ["local-llama"], matchedDir: "/work/secret", readFrom: ["/work/secret"] }),
)!;

function session(overrides: Partial<TuiSessionInfo> = {}): TuiSessionInfo {
  return {
    sessionId: "s-1",
    workingDir: "/work/secret",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chrome",
    browserHeadless: false,
    approvalLevel: 5,
    maxSteps: 10,
    completionMaxTokens: 2048,
    skillCount: 0,
    localBackendConfigured: false,
    ...overrides,
  };
}

describe("provider restriction in the TUI", () => {
  it("is set for the visible session, ignored for another, and cleared by a switch", () => {
    let state = createInitialTuiState(session());
    state = reduceTuiState(state, { type: "provider_restriction_changed", sessionId: "s-other", restriction });
    expect(state.session.providerRestriction ?? null).toBeNull();
    state = reduceTuiState(state, { type: "provider_restriction_changed", sessionId: "s-1", restriction });
    expect(state.session.providerRestriction?.label).toBe("restricted to: local-llama");
    state = reduceTuiState(state, { type: "session_switched", sessionId: "s-2", workingDir: "/x", messages: [] });
    expect(state.session.providerRestriction).toBeNull();
  });

  it("/status names it, for a folder and for a read taint", () => {
    const base = createInitialTuiState(session({ providerRestriction: restriction }));
    expect(formatTuiStatus(base, 0)).toContain("Providers: restricted to: local-llama (folder /work/secret)");
    const read = createInitialTuiState(session({ providerRestriction: tainted }));
    expect(formatTuiStatus(read, 0)).toContain("Providers: restricted to: local-llama (read files from /work/secret)");
    expect(formatTuiStatus(createInitialTuiState(session()), 0)).not.toContain("Providers:");
  });

  it("draws the chip after the route in the composer bar", () => {
    const { lastFrame, unmount } = render(
      <PromptMetaBar
        leftSlot={null}
        backend={null}
        provider="local-llama"
        model="qwen3"
        restriction={restriction.label}
        contextSlot={null}
        modeSlot={null}
      />,
    );
    expect(lastFrame()).toContain("restricted to: local-llama");
    unmount();
  });
});
