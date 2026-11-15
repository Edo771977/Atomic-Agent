import { describe, expect, it } from "vitest";

import { makeProviderPolicy } from "../config/project-constraint-match.js";
import { ProviderNotAllowedError } from "../llm/provider-policy.js";
import { TransportError } from "../llm/reliability/llm-failures.js";
import { failureReasonFields } from "./failure-reason-frame.js";

describe("failureReasonFields for a per-folder constraint refusal", () => {
  it("carries the stable code and the same sentence the TUI shows", () => {
    const policy = makeProviderPolicy({ key: "/work/client", allowedProviders: ["local-llama"], matchedDir: "/work/client" });
    const refusal = new ProviderNotAllowedError({ reason: "not-allowed", providerId: "anthropic", policy, role: "the main model" });
    const error = new TransportError(refusal.message, null, "", { cause: refusal });
    const fields = failureReasonFields(error, error, null, { localModelConfigured: false });
    expect(fields.code).toBe("ATOMIC_AGENT_PROVIDER_NOT_ALLOWED");
    expect(fields.advice).toContain("This folder is restricted to: local-llama. The main model can't use anthropic here.");
    expect(fields.advice).toContain('edit projects.constraints["/work/client"].allowedProviders');
  });
});
