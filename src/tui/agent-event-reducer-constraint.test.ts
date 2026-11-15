import { describe, expect, it } from "vitest";

import { makeProviderPolicy } from "../config/project-constraint-match.js";
import { ProviderNotAllowedError } from "../llm/provider-policy.js";
import { TransportError } from "../llm/reliability/llm-failures.js";
import { reduceTuiState, type TuiAction } from "./agent-event-reducer.js";
import { REPORT_HINT } from "./chat/format-agent-error-for-chat.js";
import { createInitialTuiState, type TuiSessionInfo, type TuiState } from "./tui-state.js";

function session(localBackendConfigured: boolean): TuiSessionInfo {
  return {
    sessionId: null,
    workingDir: "/work/client",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chrome",
    browserHeadless: false,
    approvalLevel: 5,
    maxSteps: 10,
    completionMaxTokens: 2048,
    skillCount: 0,
    localBackendConfigured,
  };
}

const policy = makeProviderPolicy({ key: "/work/client", allowedProviders: ["local-llama"], matchedDir: "/work/client" });

function failWith(state: TuiState, error: Error): string {
  const actions: TuiAction[] = [
    { type: "message_submitted" },
    { type: "agent_event", event: { type: "loop_failed", error, category: "transport" } },
  ];
  const next = actions.reduce(reduceTuiState, state);
  return next.messages.find((m) => m.role === "system" && m.variant === "warn")?.text ?? "";
}

describe("a turn a per-folder constraint refused (owner's Windows run)", () => {
  const refusal = new ProviderNotAllowedError({ reason: "none-allowed", policy, role: "the main model" });
  // What the fallback chain hands the loop: a transport failure caused by the refusal.
  const error = new TransportError(refusal.message, null, "", { cause: refusal });

  it("says the folder is restricted, offers the local switch, and drops the /report hint", () => {
    const text = failWith(createInitialTuiState(session(true)), error);
    expect(text).toContain("This folder is restricted to: local-llama.");
    expect(text).toContain("switch to local with ctrl+r or /runmode local");
    expect(text).not.toContain("couldn't get a reply from the provider");
    expect(text).not.toContain(REPORT_HINT.trim());
  });

  it("without a local model it points at projects.constraints instead", () => {
    const text = failWith(createInitialTuiState(session(false)), error);
    expect(text).toContain('edit projects.constraints["/work/client"].allowedProviders');
    expect(text).not.toContain("ctrl+r");
  });
});
