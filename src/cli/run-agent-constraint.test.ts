import { describe, expect, it } from "vitest";

import { makeProviderPolicy } from "../config/project-constraint-match.js";
import { ProviderNotAllowedError } from "../llm/provider-policy.js";
import { TransportError } from "../llm/reliability/index.js";
import { formatAgentEvent } from "./run-agent.js";

describe("CLI run: a turn a per-folder constraint refused", () => {
  const policy = makeProviderPolicy({ key: "/work/client", allowedProviders: ["local-llama"], matchedDir: "/work/client" });
  const refusal = new ProviderNotAllowedError({ reason: "not-allowed", providerId: "anthropic", policy, role: "the main model" });
  const error = new TransportError(refusal.message, null, "", { cause: refusal });

  it("prints the same sentence and hint as the TUI, not a provider failure or the llama hint", () => {
    const line = formatAgentEvent(
      { type: "loop_failed", error, category: "transport" },
      { llamaHint: "llama-server is not running", llamaUrl: "http://127.0.0.1:8080", localModelConfigured: true },
    );
    expect(line).toContain("[ATOMIC_AGENT_PROVIDER_NOT_ALLOWED]");
    expect(line).toContain("This folder is restricted to: local-llama. The main model can't use anthropic here.");
    expect(line).toContain("switch to local with ctrl+r or /runmode local");
    expect(line).not.toContain("llama-server is not running");
  });
});
